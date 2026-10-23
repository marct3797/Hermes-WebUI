import asyncio
import base64
import sys
import os
import json
import time

import pytest
from fastapi.testclient import TestClient


def configured(tmp_path, monkeypatch, **extra):
    from hostd.config import Settings
    monkeypatch.setenv('HERMES_HOSTD_TOKEN', 't' * 40)
    return Settings.from_dict(dict(
        clis=[{'id': 'cat', 'label': 'Cat', 'command': ['/bin/cat']}],
        workspaces=[{'id': 'test', 'label': 'Test', 'path': str(tmp_path)}],
        allowed_origins=['https://console.example'], **extra))


def test_http_ws_contract_and_disconnect_persistence(tmp_path, monkeypatch):
    from hostd.main import create_app
    headers = {'Authorization': 'Bearer ' + 't' * 40, 'Origin': 'https://console.example'}
    with TestClient(create_app(configured(tmp_path, monkeypatch))) as client:
        assert client.get('/v1/info').status_code == 401
        assert client.get('/v1/info', headers={**headers, 'Origin': 'https://evil.example'}).status_code == 403
        info = client.get('/v1/info', headers=headers).json()
        assert info['clis'][0]['authenticated'] is None
        assert info['clis'][0]['available'] is True
        assert client.get('/v1/terminals', headers=headers).json() == {'terminals': []}
        assert client.post('/v1/terminals', headers=headers, json={'cli': 'sh', 'workspace': 'test'}).status_code == 400
        assert client.post('/v1/terminals', headers=headers, json={'cli': 'cat', 'workspace': '../'}).status_code == 400
        assert client.post('/v1/terminals', headers=headers, json={'cli': 'cat', 'workspace': 'test', 'command': 'id'}).status_code == 422
        terminal = client.post('/v1/terminals', headers=headers, json={'cli': 'cat', 'workspace': 'test'}).json()
        url = '/v1/terminals/' + terminal['id'] + '/stream'
        with client.websocket_connect(url, headers=headers) as ws:
            assert ws.receive_json()['type'] == 'state'
            ws.send_json({'type': 'resize', 'cols': 90, 'rows': 30})
            ws.send_json({'type': 'input', 'data': base64.b64encode(b'hello\n').decode()})
            frame = ws.receive_json()
            assert frame['type'] == 'output'
            assert b'hello' in base64.b64decode(frame['data'])
        assert client.get('/v1/terminals', headers=headers).json()['terminals'][0]['running']
        with client.websocket_connect(url, headers=headers) as ws:
            assert ws.receive_json()['type'] == 'state'
            assert ws.receive_json()['type'] == 'output'
        assert client.delete('/v1/terminals/' + terminal['id'], headers=headers).status_code == 200
        assert client.get('/v1/terminals', headers=headers).json() == {'terminals': []}


def test_config_and_launch_boundaries(tmp_path, monkeypatch):
    from hostd.config import Settings
    from hostd.main import create_app
    for host in ['0.0.0.0', '::', '8.8.8.8', '224.0.0.1', 'localhost']:
        with pytest.raises(ValueError):
            Settings.from_dict({'listen_host': host})
    for host in ['127.0.0.1', '::1', '10.1.2.3', '100.100.1.2', 'fd00::1']:
        assert Settings.from_dict({'listen_host': host}).listen_host == host
    for value in [{'allow_shell': True}, {'allowed_origins': ['*']}, {'max_terminals': 0},
                  {'clis': [{'id': 'x', 'label': 'X', 'command': 'sh -c id'}]}]:
        with pytest.raises(ValueError):
            Settings.from_dict(value)
    settings = configured(tmp_path, monkeypatch)
    monkeypatch.delenv('HERMES_HOSTD_TOKEN')
    with pytest.raises(ValueError):
        create_app(settings)
    monkeypatch.setenv('HERMES_HOSTD_TOKEN', 'short')
    with pytest.raises(ValueError):
        create_app(settings)
    monkeypatch.setenv('HERMES_HOSTD_TOKEN', 't' * 40)
    monkeypatch.setattr(os, 'geteuid', lambda: 0)
    with pytest.raises(ValueError, match='root'):
        create_app(settings)


def test_limits_gap_and_workspace_retarget(tmp_path, monkeypatch):
    from hostd.terminals import TerminalManager, REPLAY_BYTES, INPUT_BYTES

    async def exercise():
        settings = configured(tmp_path, monkeypatch, max_terminals=1)
        manager = TerminalManager(settings)
        terminal = manager.create('cat', 'test')
        try:
            with pytest.raises(ValueError, match='maximum'):
                manager.create('cat', 'test')
            with pytest.raises(ValueError):
                terminal.resize(0, 24)
            with pytest.raises(ValueError):
                await terminal.write(b'a' * (INPUT_BYTES + 1))
            with pytest.raises(ValueError):
                terminal.replay(-1)
            # Real process output, not synthetic replay buffer state.
            await manager.delete(terminal.id)
            settings.clis[0]['command'] = [sys.executable, '-u', '-c',
                'import sys,time; sys.stdout.write("x"*400000); sys.stdout.flush(); time.sleep(10)']
            terminal = manager.create('cat', 'test')
            for _ in range(200):
                if terminal.offset >= 400000:
                    break
                await asyncio.sleep(.01)
            assert terminal.offset >= 400000
            assert terminal.buffer_size == REPLAY_BYTES
            frames = terminal.replay(0)
            assert frames[0]['type'] == 'gap'
            assert frames[0]['available_from'] == terminal.offset - REPLAY_BYTES
            assert sum(len(base64.b64decode(f['data'])) for f in frames[1:]) == REPLAY_BYTES
        finally:
            await manager.close()
        moved = tmp_path.with_name(tmp_path.name + '-moved')
        tmp_path.rename(moved)
        tmp_path.symlink_to(moved, target_is_directory=True)
        with pytest.raises(ValueError, match='real path'):
            settings.workspace_path('test')
    asyncio.run(exercise())


def test_ws_rejects_bad_auth_origin_and_frames(tmp_path, monkeypatch):
    from hostd.main import create_app
    from starlette.websockets import WebSocketDisconnect
    headers = {'Authorization': 'Bearer ' + 't' * 40}
    with TestClient(create_app(configured(tmp_path, monkeypatch))) as client:
        terminal = client.post('/v1/terminals', headers=headers, json={'cli': 'cat', 'workspace': 'test'}).json()
        url = '/v1/terminals/' + terminal['id'] + '/stream'
        for invalid in [{}, {**headers, 'Origin': 'https://evil.example'}]:
            with pytest.raises(WebSocketDisconnect):
                with client.websocket_connect(url, headers=invalid):
                    pass
        for frame in [{'type': 'input', 'data': '!invalid'}, {'type': 'resize', 'cols': True, 'rows': 24},
                      {'type': 'input', 'data': 'a' * 30000}, {'type': 'shell', 'command': 'id'}]:
            with client.websocket_connect(url, headers=headers) as ws:
                assert ws.receive_json()['type'] == 'state'
                ws.send_text(json.dumps(frame))
                with pytest.raises(WebSocketDisconnect):
                    ws.receive_json()
        assert client.post('/v1/terminals', headers=headers, content='x' * 5000).status_code == 413


def test_info_never_launches_cli_and_children_do_not_get_daemon_token(tmp_path, monkeypatch):
    from hostd.main import create_app
    from hostd.terminals import TerminalManager
    marker = tmp_path / 'launched'
    settings = configured(tmp_path, monkeypatch)
    settings.clis[0]['command'] = [sys.executable, '-u', '-c',
        'import os,pathlib; pathlib.Path("launched").write_text("yes"); '
        'print("TOKEN_PRESENT", "HERMES_HOSTD_TOKEN" in os.environ,flush=True)']
    with TestClient(create_app(settings)) as client:
        assert client.get('/v1/info', headers={'Authorization': 'Bearer ' + 't' * 40}).status_code == 200
        assert not marker.exists()

    async def exercise():
        manager = TerminalManager(settings)
        terminal = manager.create('cat', 'test')
        try:
            for _ in range(100):
                if not terminal.describe()['running'] and terminal.fd == -1:
                    break
                await asyncio.sleep(.02)
            data = b''.join(base64.b64decode(f['data']) for f in terminal.replay(0) if f['type'] == 'output')
            assert b'TOKEN_PRESENT False' in data
            assert terminal.describe()['exit_code'] == 0
        finally:
            await manager.close()
    asyncio.run(exercise())


def test_binary_ws_frame_is_policy_rejection(tmp_path, monkeypatch):
    from hostd.main import create_app
    from starlette.websockets import WebSocketDisconnect
    headers = {'Authorization': 'Bearer ' + 't' * 40}
    with TestClient(create_app(configured(tmp_path, monkeypatch))) as client:
        terminal = client.post('/v1/terminals', headers=headers, json={'cli': 'cat', 'workspace': 'test'}).json()
        with client.websocket_connect('/v1/terminals/' + terminal['id'] + '/stream', headers=headers) as ws:
            assert ws.receive_json()['type'] == 'state'
            ws.send_bytes(b'not json text')
            with pytest.raises(WebSocketDisconnect) as exc:
                ws.receive_json()
            assert exc.value.code == 1008


def test_installer_is_valid_shell_and_user_scoped():
    import subprocess
    from pathlib import Path
    script = Path(__file__).resolve().parents[2] / 'deploy/install-hostd.sh'
    assert script.is_file()
    assert subprocess.run(['bash', '-n', str(script)], capture_output=True).returncode == 0
    text = script.read_text()
    assert 'systemctl --user' in text
    assert 'EnvironmentFile=' in text
    assert 'ExecStart=' in text
    assert 'KillMode=control-group' in text


def test_real_pty_roundtrip_resize_replay_and_shutdown(tmp_path):
    from hostd.config import Settings
    from hostd.terminals import TerminalManager

    async def exercise():
        settings = Settings.from_dict({
            'clis': [{'id': 'python', 'label': 'Python', 'command': [sys.executable, '-u', '-c',
                'import os,sys; print("TTY",os.isatty(0),flush=True); '
                '\nfor line in sys.stdin: print("REPLY:"+line.strip(),flush=True)']}],
            'workspaces': [{'id': 'test', 'label': 'Test', 'path': str(tmp_path)}],
        })
        manager = TerminalManager(settings)
        terminal = manager.create('python', 'test', 80, 24)
        try:
            for _ in range(100):
                if b'TTY True' in b''.join(base64.b64decode(f['data']) for f in terminal.replay(0) if f['type'] == 'output'):
                    break
                await asyncio.sleep(.02)
            else:
                raise AssertionError('real PTY never became ready')
            terminal.resize(100, 40)
            await terminal.write(b'hello\n')
            for _ in range(100):
                frames = terminal.replay(0)
                if b'REPLY:hello' in b''.join(base64.b64decode(f['data']) for f in frames if f['type'] == 'output'):
                    break
                await asyncio.sleep(.02)
            else:
                raise AssertionError('PTY input did not reach real process')
            assert terminal.describe()['running']
            assert terminal.describe()['pid'] > 0
        finally:
            await manager.close()
        assert not terminal.describe()['running']
        assert terminal.fd == -1

    asyncio.run(exercise())


def test_exited_terminal_is_listed_deletable_and_pruned_after_ttl(tmp_path, monkeypatch):
    from hostd.main import create_app
    headers = {'Authorization': 'Bearer ' + 't' * 40, 'Origin': 'https://console.example'}
    settings = configured(tmp_path, monkeypatch, exited_ttl_s=1)
    settings.clis[0]['command'] = [sys.executable, '-c', 'print("bye")']
    with TestClient(create_app(settings)) as client:
        def listing():
            return client.get('/v1/terminals', headers=headers).json()['terminals']
        first = client.post('/v1/terminals', headers=headers, json={'cli': 'cat', 'workspace': 'test'}).json()
        for _ in range(100):
            if not listing()[0]['running']:
                break
            time.sleep(.05)
        entry = listing()[0]
        assert entry['running'] is False and entry['exit_code'] == 0  # echte Form wie real_terminals_after_exit.json
        # Replay bleibt bis zum Ablauf erhalten.
        with client.websocket_connect('/v1/terminals/' + first['id'] + '/stream', headers=headers) as ws:
            assert ws.receive_json()['type'] == 'state'
            assert b'bye' in base64.b64decode(ws.receive_json()['data'])
        assert client.delete('/v1/terminals/' + first['id'], headers=headers).status_code == 200
        second = client.post('/v1/terminals', headers=headers, json={'cli': 'cat', 'workspace': 'test'}).json()
        time.sleep(1.5)
        assert listing() == [] or all(t['id'] != second['id'] for t in listing())
        assert client.delete('/v1/terminals/' + second['id'], headers=headers).status_code == 404


def test_invalid_exited_ttl_rejected(tmp_path, monkeypatch):
    with pytest.raises(ValueError):
        configured(tmp_path, monkeypatch, exited_ttl_s=-1)
