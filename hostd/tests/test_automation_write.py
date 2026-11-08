"""Änderungen an Zielen, Heartbeats und Schleifen laufen über den Hermes-Client (hier ein Ersatz-Paket `hermes_cli`), nie über state.db."""
import json
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

FAKE = '''
import json, os
class Client:
    async def rpc(self, method, **params):
        with open(os.environ["FAKE_LOG"], "a") as f:
            f.write(json.dumps([method, params]) + "\\n")
        if method == "session.resume":
            if params["session_id"] == "missing":
                raise RuntimeError("not_found")
            return {"session_id": "live-" + params["session_id"]}
        if params["call"] == "set" and params["kind"] == "heartbeat" and params["args"][1] < 60:
            return {"error": {"type": "ValueError", "message": "interval must be at least 60s"}, "state": None}
        if params["call"] == "clear":
            return {"value": True, "state": None}
        return {"value": None, "state": {"status": {"pause": "paused", "resume": "active", "set": "active"}[params["call"]]}}
class _Ctx:
    async def __aenter__(self): return Client()
    async def __aexit__(self, *a): return False
def connect_gateway(*a, **k): return _Ctx()
'''


def setup(tmp_path, monkeypatch, allow=True, python=True):
    from hostd.operations import router
    src = tmp_path / 'src' / 'hermes_cli'
    src.mkdir(parents=True, exist_ok=True)
    (src / '__init__.py').write_text('')
    (src / 'gateway_client.py').write_text(FAKE)
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
    assert r.status_code == 200 and r.json() == {'ok': True, 'kind': 'goal', 'action': 'set', 'status': 'active'}
    assert calls(log) == [['session.resume', {'session_id': 's1'}],
                          ['session.automation', {'session_id': 'live-s1', 'kind': 'goal', 'call': 'set', 'args': ['Alle Tests grün'], 'kwargs': {'max_turns': 12}}]]


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
