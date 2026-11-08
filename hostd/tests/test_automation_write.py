"""Änderungen an Zielen, Heartbeats und Schleifen laufen über den Hermes-Client (hier ein Ersatz-Paket `hermes_cli`), nie über state.db."""
import json
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

FAKE = '''
import json, os
def log(entry):
    with open(os.environ["FAKE_LOG"], "a") as f:
        f.write(json.dumps(entry) + "\\n")
class Client:
    async def rpc(self, method, **params):
        log([method, params])
        if method == "session.resume":
            if params["session_id"] == "missing":
                raise RuntimeError("not_found")
            return {"session_id": "live-" + params["session_id"]}
        if method == "prompt.submit":
            return {} if os.environ.get("FAKE_NO_ADMISSION") else {"admission_id": "a1"}
        if params["call"] == "set" and params["kind"] == "heartbeat" and params["args"][1] < 60:
            return {"error": {"type": "ValueError", "message": "interval must be at least 60s"}, "state": None}
        if params["call"] == "clear":
            return {"value": True, "state": None}
        if params["call"] == "command":
            return {"value": {"output": "resumed", "prompt": "Weiterarbeiten am Ziel", "kickoff": False}, "state": {"status": "active"}}
        return {"value": None, "state": {"status": {"pause": "paused", "resume": "active", "set": "active"}[params["call"]]}}
class _Ctx:
    def __init__(self, endpoint): log(["connect_gateway", {"endpoint": endpoint}])
    async def __aenter__(self): return Client()
    async def __aexit__(self, *a): return False
def connect_gateway(endpoint=None, *a, **k):
    if endpoint is None:
        raise AssertionError("connect_gateway without endpoint would start a gateway")
    return _Ctx(endpoint)
'''
RUNTIME = '''
import os
class Found:
    def __init__(self):
        down = os.environ.get("FAKE_GATEWAY") == "down"
        self.state, self.reason_code, self.endpoint = ("not_running", "no_owner", None) if down else ("ready", None, "ws://127.0.0.1:1")
def discover_gateway_endpoint(home, timeout=2.0): return Found()
def attachable(found): return found.endpoint is not None and found.state == "ready"
def gateway_profile_home(home): return home
'''
GOALS = '''
def goal_kick_prompt(goal, last): return goal
'''
CONSTANTS = '''
import os
def get_hermes_home(): return os.environ["HERMES_HOME"]
'''


def setup(tmp_path, monkeypatch, allow=True, python=True):
    from hostd.operations import router
    src = tmp_path / 'src' / 'hermes_cli'
    src.mkdir(parents=True, exist_ok=True)
    (src / '__init__.py').write_text('')
    (src / 'gateway_client.py').write_text(FAKE)
    (src / 'gateway_runtime.py').write_text(RUNTIME)
    (src / 'goals.py').write_text(GOALS)
    (src.parent / 'hermes_constants.py').write_text(CONSTANTS)
    root = tmp_path / 'p'
    root.mkdir(exist_ok=True)
    log = tmp_path / 'calls.log'
    monkeypatch.setenv('FAKE_LOG', str(log))
    app = FastAPI()
    settings = {'workspaces': [], 'profiles': [{'id': 'p', 'path': str(root), 'allow_automation': allow}]}
    if python:
        settings.update(native_python=sys.executable, native_source=str(tmp_path / 'src'))
    app.state.settings = settings
    app.include_router(router)
    return TestClient(app), log


def calls(log):
    return [json.loads(l) for l in log.read_text().splitlines()] if log.exists() else []


def post(client, **body):
    return client.post('/v1/profiles/p/automation', json={'session_id': 's1', **body})


def test_goal_set_resumes_the_session_then_calls_session_automation(tmp_path, monkeypatch):
    client, log = setup(tmp_path, monkeypatch)
    r = post(client, kind='goal', action='set', text='  Alle Tests grün ', max_turns=12)
    assert r.status_code == 200 and r.json() == {'ok': True, 'kind': 'goal', 'action': 'set', 'status': 'active', 'started': True}
    assert r.json()['started'] is True
    done = calls(log)
    assert [c[0] for c in done] == ['connect_gateway', 'session.resume', 'session.automation', 'prompt.submit']
    assert done[0][1] == {'endpoint': 'ws://127.0.0.1:1'}  # nie ohne Endpunkt: hostd startet keinen Gateway
    assert done[2][1] == {'session_id': 'live-s1', 'kind': 'goal', 'call': 'set', 'args': ['Alle Tests grün'], 'kwargs': {'max_turns': 12}}
    assert done[3][1]['text'] == 'Alle Tests grün' and done[3][1]['session_id'] == 'live-s1' and done[3][1]['queued'] is True


@pytest.mark.parametrize('kind,action,status', [('goal', 'pause', 'paused'), ('heartbeat', 'resume', 'active'), ('loop', 'pause', 'paused'), ('loop', 'clear', 'cleared')])
def test_pause_resume_clear(tmp_path, monkeypatch, kind, action, status):
    client, log = setup(tmp_path, monkeypatch)
    assert post(client, kind=kind, action=action).json()['status'] == status
    assert calls(log)[-1][1]['call'] == action and calls(log)[-1][1]['args'] == []


def test_heartbeat_set_needs_text_and_interval_and_hermes_limits_come_back(tmp_path, monkeypatch):
    client, log = setup(tmp_path, monkeypatch)
    assert post(client, kind='heartbeat', action='set', text='CI prüfen').status_code == 422
    assert post(client, kind='heartbeat', action='set', interval_seconds=600).status_code == 422
    assert calls(log) == []
    r = post(client, kind='heartbeat', action='set', text='CI prüfen', interval_seconds=30)
    assert r.status_code == 422 and 'at least 60' in r.text
    assert post(client, kind='heartbeat', action='set', text='CI prüfen', interval_seconds=600).status_code == 200


def test_loop_cannot_be_created_and_input_is_strict(tmp_path, monkeypatch):
    client, log = setup(tmp_path, monkeypatch)
    assert post(client, kind='loop', action='set', text='x', interval_seconds=60).status_code == 422
    assert post(client, kind='goal', action='clear', extra=1).status_code == 422
    assert post(client, kind='goal', action='explode').status_code == 422
    assert client.post('/v1/profiles/p/automation', json={'session_id': '../x', 'kind': 'goal', 'action': 'clear'}).status_code == 422
    assert calls(log) == []


def test_disabled_profile_and_missing_client_do_nothing(tmp_path, monkeypatch):
    client, log = setup(tmp_path, monkeypatch, allow=False)
    assert post(client, kind='goal', action='clear').status_code == 403
    client, log = setup(tmp_path, monkeypatch, python=False)
    assert post(client, kind='goal', action='clear').status_code == 501
    assert calls(log) == []


def test_unknown_session_is_reported_as_refused(tmp_path, monkeypatch):
    client, _ = setup(tmp_path, monkeypatch)
    r = client.post('/v1/profiles/p/automation', json={'session_id': 'missing', 'kind': 'goal', 'action': 'clear'})
    assert r.status_code == 409 and 'not_found' in r.text


def test_broken_client_gives_bad_gateway(tmp_path, monkeypatch):
    client, _ = setup(tmp_path, monkeypatch)
    (tmp_path / 'src' / 'hermes_cli' / 'gateway_client.py').write_text('raise SystemExit(3)')
    assert post(client, kind='goal', action='clear').status_code in (409, 502)


def test_state_db_is_never_written(tmp_path, monkeypatch):
    client, _ = setup(tmp_path, monkeypatch)
    post(client, kind='goal', action='clear')
    assert not (tmp_path / 'p' / 'state.db').exists()


def test_resume_goal_uses_the_goal_command_and_kicks_its_prompt(tmp_path, monkeypatch):
    client, log = setup(tmp_path, monkeypatch)
    r = post(client, kind='goal', action='resume')
    assert r.status_code == 200 and r.json()['started'] is True and r.json()['status'] == 'active'
    done = calls(log)
    assert done[2][1]['call'] == 'command' and done[2][1]['args'] == ['resume']
    assert done[3][0] == 'prompt.submit' and done[3][1]['text'] == 'Weiterarbeiten am Ziel'


@pytest.mark.parametrize('kind,action', [('goal', 'pause'), ('goal', 'clear'), ('heartbeat', 'set'), ('heartbeat', 'resume'), ('loop', 'resume')])
def test_only_goal_set_and_resume_start_a_run(tmp_path, monkeypatch, kind, action):
    client, log = setup(tmp_path, monkeypatch)
    extra = {'text': 'x', 'interval_seconds': 600} if action == 'set' else {}
    r = post(client, kind=kind, action=action, **extra)
    assert r.status_code == 200 and r.json()['started'] is None
    assert 'prompt.submit' not in [c[0] for c in calls(log)]


def test_a_kick_without_admission_is_reported_as_not_started(tmp_path, monkeypatch):
    monkeypatch.setenv('FAKE_NO_ADMISSION', '1')
    client, _ = setup(tmp_path, monkeypatch)
    r = post(client, kind='goal', action='set', text='Ziel')
    assert r.status_code == 200 and r.json()['started'] is False


def test_no_running_gateway_means_503_and_nothing_is_started(tmp_path, monkeypatch):
    monkeypatch.setenv('FAKE_GATEWAY', 'down')
    client, log = setup(tmp_path, monkeypatch)
    r = post(client, kind='goal', action='set', text='Ziel')
    assert r.status_code == 503
    assert calls(log) == []  # weder verbunden noch gestartet
