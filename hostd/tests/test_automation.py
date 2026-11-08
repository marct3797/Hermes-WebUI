"""Ziele, Heartbeats und Schleifen aus state_meta: nur lesend, nur erlaubte Felder, nichts Gelöschtes."""
import json
import sqlite3

from fastapi import FastAPI
from fastapi.testclient import TestClient


def setup(tmp_path, rows=(), sessions=(('s1', 'Release prüfen'),)):
    from hostd.operations import router
    root = tmp_path / 'p'
    root.mkdir()
    conn = sqlite3.connect(root / 'state.db')
    conn.execute('CREATE TABLE state_meta (key TEXT PRIMARY KEY, value TEXT)')
    conn.execute('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT)')
    conn.executemany('INSERT INTO sessions VALUES (?,?)', sessions)
    conn.executemany('INSERT INTO state_meta VALUES (?,?)', [(k, v if isinstance(v, str) else json.dumps(v)) for k, v in rows])
    conn.commit()
    conn.close()
    app = FastAPI()
    app.state.settings = {'workspaces': [], 'profiles': [{'id': 'p', 'path': str(root)}]}
    app.include_router(router)
    return TestClient(app), root


def test_lists_goal_heartbeat_and_loop_with_session_title(tmp_path):
    client, _ = setup(tmp_path, [
        ('goal:s1', {'goal': 'Alle Tests grün', 'status': 'active', 'turns_used': 3, 'max_turns': 20, 'last_verdict': 'continue', 'last_reason': 'noch 2 rot',
                     'subgoals': ['ruff sauber'], 'gates': [{'cmd': 'pytest'}], 'route': {'chat_id': 'geheim'}}),
        ('heartbeat:s1', {'prompt': 'CI prüfen', 'interval_seconds': 600, 'status': 'paused', 'fire_count': 4}),
        ('loop:s1', {'prompt': 'Deploy beobachten', 'mode': 'interval', 'interval_seconds': 300, 'status': 'active', 'ticks_fired': 2, 'route': {'chat_id': 'x'}}),
    ])
    body = client.get('/v1/profiles/p/automation').json()
    assert body['available'] is True and body['truncated'] is False
    by = {i['kind']: i for i in body['items']}
    assert set(by) == {'goal', 'heartbeat', 'loop'}
    assert by['goal']['title'] == 'Release prüfen' and by['goal']['text'] == 'Alle Tests grün'
    assert by['goal']['turns_used'] == 3 and by['goal']['subgoals'] == ['ruff sauber'] and by['goal']['gates'] == 1
    assert by['heartbeat']['interval_seconds'] == 600 and by['heartbeat']['status'] == 'paused'
    assert 'route' not in by['loop'] and 'geheim' not in json.dumps(body)
    assert [i['kind'] for i in body['items']][-1] == 'heartbeat'  # aktive zuerst, pausierte danach


def test_cleared_and_broken_rows_are_skipped(tmp_path):
    client, _ = setup(tmp_path, [('goal:s1', {'goal': 'x', 'status': 'cleared'}), ('loop:s1', 'kein json'), ('other:s1', {'status': 'active'})])
    assert client.get('/v1/profiles/p/automation').json()['items'] == []


def test_missing_database_is_reported_not_an_error(tmp_path):
    client, root = setup(tmp_path)
    (root / 'state.db').unlink()
    body = client.get('/v1/profiles/p/automation').json()
    assert body['available'] is False and body['items'] == []


def test_database_is_never_written(tmp_path):
    client, root = setup(tmp_path, [('goal:s1', {'goal': 'x', 'status': 'active'})])
    before = (root / 'state.db').read_bytes()
    client.get('/v1/profiles/p/automation')
    assert (root / 'state.db').read_bytes() == before


def test_unknown_profile_is_404(tmp_path):
    client, _ = setup(tmp_path)
    assert client.get('/v1/profiles/nope/automation').status_code in (404, 400)
