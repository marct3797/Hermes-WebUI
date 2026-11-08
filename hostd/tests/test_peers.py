"""Bot-Modus-Peers: Schlüssel und Nachricht nur über stdin, nie zurück; feste Aktionen, Flag je Profil. Hermes ist hier ein Ersatz (`hermes_cli.subcommands.peer`)."""
import json
import sys

from fastapi import FastAPI
from fastapi.testclient import TestClient

PEER = '''
import json, os, sys
def _load_peers(): return json.load(open(os.environ["FAKE_PEERS"])) if os.path.exists(os.environ["FAKE_PEERS"]) else {}
def _peer_secret(name): return "k" if name in json.load(open(os.environ["FAKE_PEERS"] + ".keys")) else ""
def cmd_peer(a):
    peers = _load_peers()
    keys = json.load(open(os.environ["FAKE_PEERS"] + ".keys")) if os.path.exists(os.environ["FAKE_PEERS"] + ".keys") else {}
    open(os.environ["FAKE_LOG"], "a").write(json.dumps({"a": a.peer_action, "key": a.key, "message": a.message, "target": a.target, "argv": sys.argv[1:]}) + "\\n")
    if a.peer_action == "add":
        peers[a.name] = {"url": a.url, "note": a.note}; keys[a.name] = a.key
        json.dump(peers, open(os.environ["FAKE_PEERS"], "w")); json.dump(keys, open(os.environ["FAKE_PEERS"] + ".keys", "w"))
        print("saved " + a.key)
        return 0
    if a.peer_action == "remove":
        peers.pop(a.name, None); json.dump(peers, open(os.environ["FAKE_PEERS"], "w")); return 0
    if a.peer_action == "run":
        print(json.dumps({"peer": a.target, "run_id": "run_1", "status": "started", "session_id": "s1"})); return 0
    print("Could not reach peer", file=sys.stderr); return 1
'''


def setup(tmp_path, monkeypatch, flag=True, python=True):
    from hostd.operations import router
    pkg = tmp_path / 'src' / 'hermes_cli' / 'subcommands'
    pkg.mkdir(parents=True, exist_ok=True)
    (tmp_path / 'src' / 'hermes_cli' / '__init__.py').write_text('')
    (pkg / '__init__.py').write_text('')
    (pkg / 'peer.py').write_text(PEER)
    root = tmp_path / 'p'
    root.mkdir(exist_ok=True)
    monkeypatch.setenv('FAKE_PEERS', str(tmp_path / 'peers.json'))
    monkeypatch.setenv('FAKE_LOG', str(tmp_path / 'log'))
    (tmp_path / 'peers.json.keys').write_text('{}')
    app = FastAPI()
    settings = {'workspaces': [], 'profiles': [{'id': 'p', 'path': str(root), 'allow_peers': flag}]}
    if python:
        settings.update(native_python=sys.executable, native_source=str(tmp_path / 'src'))
    app.state.settings = settings
    app.include_router(router)
    return TestClient(app)


def post(c, **body):
    return c.post('/v1/profiles/p/peers', json=body)


def test_add_list_remove_never_returns_the_key(tmp_path, monkeypatch):
    c = setup(tmp_path, monkeypatch)
    r = post(c, action='add', name='spark', url='http://spark.lan:8377/', key='SECRET-KEY-1', note='Labor')
    assert r.status_code == 200 and r.json()['ok'] is True and 'SECRET-KEY-1' not in r.text
    listed = post(c, action='list').json()
    assert listed['peers'] == [{'name': 'spark', 'url': 'http://spark.lan:8377', 'note': 'Labor', 'has_key': True}]
    assert 'SECRET-KEY-1' not in json.dumps(listed)
    log = (tmp_path / 'log').read_text()
    assert '"key": "SECRET-KEY-1"' in log and 'SECRET-KEY-1' not in json.dumps([json.loads(l)['argv'] for l in log.splitlines()])
    assert post(c, action='remove', name='spark').json()['ok'] is True
    assert post(c, action='list').json()['peers'] == []


def test_run_passes_message_by_stdin_and_returns_the_run(tmp_path, monkeypatch):
    c = setup(tmp_path, monkeypatch)
    r = post(c, action='run', target='spark/researcher', message='Hallo Peer', idempotency_key='ticket-1')
    assert r.status_code == 200 and r.json()['result']['run_id'] == 'run_1'
    line = json.loads((tmp_path / 'log').read_text().splitlines()[-1])
    assert line['message'] == 'Hallo Peer' and line['target'] == 'spark/researcher' and 'Hallo Peer' not in json.dumps(line['argv'])


def test_status_failure_is_reported_without_a_result(tmp_path, monkeypatch):
    c = setup(tmp_path, monkeypatch)
    r = post(c, action='status', target='spark', run_id='run_1')
    assert r.status_code == 200 and r.json()['ok'] is False and r.json()['result'] is None and 'Could not reach' in r.json()['error']


def test_inputs_are_checked(tmp_path, monkeypatch):
    c = setup(tmp_path, monkeypatch)
    bad = [
        dict(action='add', name='Spark', url='http://x', key='k'),
        dict(action='add', name='spark', url='ftp://x', key='k'),
        dict(action='add', name='spark', url='http://user:pw@x', key='k'),
        dict(action='add', name='spark', url='http://x/?a=1', key='k'),
        dict(action='add', name='spark', url='http://x#f', key='k'),
        dict(action='add', name='spark', url='http://x:99999', key='k'),
        dict(action='add', name='spark', url='http://x', key='a\nb'),
        dict(action='run', target='../x', message='m'),
        dict(action='run', target='spark', message='  '),
        dict(action='run', target='spark', message='m', idempotency_key='a b'),
        dict(action='status', target='spark', run_id='a/b'),
        dict(action='stop', target='spark', run_id=''),
        dict(action='remove', name='a b'),
    ]
    for body in bad:
        assert post(c, **body).status_code == 422, body
    assert not (tmp_path / 'log').exists()


def test_flag_and_client_are_required(tmp_path, monkeypatch):
    assert post(setup(tmp_path, monkeypatch, flag=False), action='list').status_code == 403
    assert post(setup(tmp_path, monkeypatch, python=False), action='list').status_code == 501


def test_old_hermes_gives_426(tmp_path, monkeypatch):
    c = setup(tmp_path, monkeypatch)
    (tmp_path / 'src' / 'hermes_cli' / 'subcommands' / 'peer.py').unlink()
    assert post(c, action='list').status_code == 426
