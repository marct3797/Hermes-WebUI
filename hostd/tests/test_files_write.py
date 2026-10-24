"""Schreibwege mit echtem Dateisystem: Konkurrenz, Traversal, Symlinks, Denylist, Rechte."""
import hashlib
import json
import os
import subprocess
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def setup(tmp_path):
    from hostd.operations import router
    root = tmp_path / 'workspace'
    root.mkdir()
    app = FastAPI()
    app.state.settings = {'workspaces': [{'id': 'w', 'label': 'Work', 'path': str(root)}], 'profiles': []}
    app.include_router(router)
    return TestClient(app), root, tmp_path


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def put(client, path, content, **extra):
    return client.put('/v1/files/write', json={'workspace': 'w', 'path': path, 'content': content, **extra})


def test_create_then_overwrite_with_sha_and_mode_kept(setup):
    client, root, _ = setup
    made = put(client, 'a.txt', 'eins\n', create=True)
    assert made.status_code == 200 and made.json()['sha256'] == sha('eins\n') and made.json()['size'] == 5
    assert (root / 'a.txt').read_text() == 'eins\n'
    assert put(client, 'a.txt', 'x', create=True).status_code == 409
    (root / 'a.txt').chmod(0o640)
    read = client.get('/v1/files', params={'workspace': 'w', 'path': 'a.txt', 'full': 'true'}).json()
    assert read['sha256'] == sha('eins\n') and read['editable'] is True
    saved = put(client, 'a.txt', 'zwei\n', expected_sha256=read['sha256'])
    assert saved.status_code == 200 and saved.json()['sha256'] == sha('zwei\n')
    assert (root / 'a.txt').read_text() == 'zwei\n' and (root / 'a.txt').stat().st_mode & 0o777 == 0o640
    assert not [p for p in root.iterdir() if p.name.startswith('.hostd-tmp')]


def test_overwrite_needs_matching_sha(setup):
    client, root, _ = setup
    (root / 'a.txt').write_text('alt')
    assert put(client, 'a.txt', 'neu').status_code == 422
    assert put(client, 'a.txt', 'neu', expected_sha256=sha('anders')).status_code == 409
    assert (root / 'a.txt').read_text() == 'alt'
    assert put(client, 'fehlt.txt', 'neu', expected_sha256=sha('x')).status_code == 404
    assert not (root / 'fehlt.txt').exists()
    assert not [p for p in root.iterdir() if p.name.startswith('.hostd-tmp')]


def test_race_file_changes_between_check_and_swap(setup, monkeypatch):
    client, root, _ = setup
    (root / 'a.txt').write_text('alt')
    from hostd import workspace
    real, calls = workspace.sha_of, []

    def racing(fd):
        calls.append(1)
        if len(calls) == 2:  # zweite Pruefung kurz vor dem Tausch
            (root / 'a.txt').write_text('fremd')
        return real(fd)
    monkeypatch.setattr(workspace, 'sha_of', racing)
    assert put(client, 'a.txt', 'neu', expected_sha256=sha('alt')).status_code == 409
    assert (root / 'a.txt').read_text() == 'fremd'


def test_denylist_binary_size_and_traversal(setup, tmp_path):
    client, root, _ = setup
    for path in ['.env', '.git/config', 'sub/../x', '../x', '/etc/x', 'config.yaml', 'id_rsa', 'my-token.txt']:
        assert put(client, path, 'x', create=True).status_code == 403, path
        assert client.post('/v1/files/mkdir', json={'workspace': 'w', 'path': path}).status_code == 403, path
    assert put(client, 'bin.txt', 'a\x00b', create=True).status_code == 415
    assert put(client, 'big.txt', 'x' * (1048576 + 1), create=True).status_code in (413, 422)
    assert put(client, 'ok.txt', 'ä' * 600000, create=True).status_code == 413  # Bytes zaehlen, nicht Zeichen
    (root / 'blob.txt').write_bytes(b'\x00\x01binary')
    assert put(client, 'blob.txt', 'x', expected_sha256=sha('x')).status_code == 415
    assert client.put('/v1/files/write', json={'workspace': 'w', 'path': 'a', 'content': '', 'extra': 1}).status_code == 422


def test_symlinks_never_followed(setup, tmp_path):
    client, root, _ = setup
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'secret.txt').write_text('geheim')
    (root / 'dirlink').symlink_to(outside)
    (root / 'filelink.txt').symlink_to(outside / 'secret.txt')
    assert put(client, 'dirlink/new.txt', 'x', create=True).status_code == 403
    assert put(client, 'filelink.txt', 'x', expected_sha256=sha('geheim')).status_code == 403
    assert client.post('/v1/files/mkdir', json={'workspace': 'w', 'path': 'dirlink/d'}).status_code == 403
    assert client.post('/v1/files/move', json={'workspace': 'w', 'from': 'filelink.txt', 'to': 'b.txt'}).status_code == 403
    (root / 'a.txt').write_text('a')
    assert client.post('/v1/files/move', json={'workspace': 'w', 'from': 'a.txt', 'to': 'dirlink/a.txt'}).status_code == 403
    assert (outside / 'secret.txt').read_text() == 'geheim' and not (outside / 'new.txt').exists()


def test_mkdir_rules(setup):
    client, root, _ = setup
    ok = client.post('/v1/files/mkdir', json={'workspace': 'w', 'path': 'neu'})
    assert ok.status_code == 200 and (root / 'neu').stat().st_mode & 0o777 == 0o700
    assert client.post('/v1/files/mkdir', json={'workspace': 'w', 'path': 'neu'}).status_code == 409
    assert client.post('/v1/files/mkdir', json={'workspace': 'w', 'path': 'a/b'}).status_code == 404  # Eltern muessen existieren
    assert client.post('/v1/files/mkdir', json={'workspace': 'w', 'path': ''}).status_code == 422
    assert client.post('/v1/files/mkdir', json={'workspace': 'nope', 'path': 'x'}).status_code == 404


def test_move_file_and_dir_rules(setup):
    client, root, _ = setup
    (root / 'a.txt').write_text('a')
    (root / 'b.txt').write_text('b')
    (root / 'd').mkdir()
    (root / 'd' / 'inner.txt').write_text('i')
    move = lambda a, b: client.post('/v1/files/move', json={'workspace': 'w', 'from': a, 'to': b})
    assert move('a.txt', 'b.txt').status_code == 409 and (root / 'b.txt').read_text() == 'b'
    assert move('a.txt', 'd/a2.txt').status_code == 200
    assert not (root / 'a.txt').exists() and (root / 'd' / 'a2.txt').read_text() == 'a'
    assert move('d', 'e').status_code == 200 and (root / 'e' / 'inner.txt').exists()
    (root / 'x').mkdir()
    assert move('e', 'x').status_code == 409
    assert move('e', 'e/sub').status_code == 400
    assert move('e', 'e').status_code == 400
    assert move('fehlt', 'z').status_code == 404
    assert move('b.txt', 'nope/b.txt').status_code == 404
    assert move('b.txt', '.env').status_code == 403
    assert move('.env', 'z').status_code == 403


def test_listing_has_kind_size_mtime_and_workspaces_is_git(setup):
    client, root, _ = setup
    (root / 'a.txt').write_text('abc')
    (root / 'd').mkdir()
    entries = {e['name']: e for e in client.get('/v1/files', params={'workspace': 'w'}).json()['entries']}
    assert entries['a.txt']['kind'] == 'file' and entries['a.txt']['size'] == 3 and isinstance(entries['a.txt']['mtime'], int)
    assert entries['d']['kind'] == 'directory'
    assert client.get('/v1/workspaces').json() == {'workspaces': [{'id': 'w', 'label': 'Work', 'is_git': False}]}
    subprocess.run(['git', 'init', '-q'], cwd=root, check=True)
    assert client.get('/v1/workspaces').json()['workspaces'][0]['is_git'] is True


def test_preview_is_short_but_editor_read_is_full_and_large_files_not_editable(setup):
    client, root, _ = setup
    (root / 'a.txt').write_text('x' * 70000)
    preview = client.get('/v1/files', params={'workspace': 'w', 'path': 'a.txt'}).json()
    assert len(preview['content']) == 65536 and preview['truncated'] is True and preview['sha256'] == sha('x' * 70000)
    full = client.get('/v1/files', params={'workspace': 'w', 'path': 'a.txt', 'full': 'true'}).json()
    assert len(full['content']) == 70000 and full['truncated'] is False
    (root / 'huge.txt').write_text('y' * 1048577)
    huge = client.get('/v1/files', params={'workspace': 'w', 'path': 'huge.txt', 'full': 'true'}).json()
    assert huge['editable'] is False and huge['truncated'] is True and 'sha256' not in huge


def test_git_files_log_branches_without_secrets(setup):
    client, root, _ = setup
    git = lambda *a: subprocess.run(['git', *a], cwd=root, check=True, capture_output=True)
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Alpha')
    git('config', 'user.email', 'a@example.invalid')
    (root / 'a.txt').write_text('1\n')
    git('add', '.')
    git('commit', '-qm', 'erster Stand')
    git('branch', 'feature')
    (root / 'a.txt').write_text('2\n')
    (root / 'neu.txt').write_text('n\n')
    (root / '.env').write_text('SECRET=1\n')
    data = client.get('/v1/git', params={'workspace': 'w'}).json()
    assert {(f['path'], f['state']) for f in data['files']} == {('a.txt', 'M'), ('neu.txt', '??')}
    assert data['log'][0]['subject'] == 'erster Stand' and data['log'][0]['author'] == 'Alpha' and len(data['log'][0]['hash']) == 40
    assert {(b['name'], b['current']) for b in data['branches']} == {('main', True), ('feature', False)}
    assert '.env' not in json.dumps(data)


def test_git_fresh_repo_without_commits(setup):
    client, root, _ = setup
    subprocess.run(['git', 'init', '-q', '-b', 'main'], cwd=root, check=True)
    (root / 'a.txt').write_text('1\n')
    data = client.get('/v1/git', params={'workspace': 'w'}).json()
    assert data['log'] == [] and data['files'] == [{'path': 'a.txt', 'state': '??'}]


def test_daemon_limit_allows_large_write(tmp_path, monkeypatch):
    from hostd.main import create_app
    root = tmp_path / 'ws'
    root.mkdir()
    monkeypatch.setenv('HERMES_HOSTD_TOKEN', 't' * 40)
    app = create_app({'workspaces': [{'id': 'w', 'label': 'W', 'path': str(root)}]})
    client = TestClient(app)
    headers = {'Authorization': 'Bearer ' + 't' * 40}
    body = {'workspace': 'w', 'path': 'a.txt', 'content': '\n' * 1000000, 'create': True}
    # ensure_ascii-Escapes (\n -> 2 Byte) ueberschreiten das alte 1,5-MB-Limit, bleiben aber unter 1 MiB Inhalt
    assert client.put('/v1/files/write', json=body, headers=headers).status_code == 200
    assert client.put('/v1/files/write', json={**body, 'path': 'b.txt', 'content': 'x' * 2000000, 'create': True}, headers=headers).status_code == 422
    assert client.post('/v1/files/mkdir', content=b'{' + b' ' * 1600000 + b'}', headers=headers).status_code == 413


def run_cli(*args):
    return subprocess.run([sys.executable, '-m', 'hostd.workspaces', *args], capture_output=True, text=True,
                          env={**os.environ, 'PYTHONPATH': os.getcwd()})


def test_workspaces_cli_add_list_validation(tmp_path):
    config = tmp_path / 'config.json'
    config.write_text(json.dumps({'listen_host': '127.0.0.1', 'port': 8790, 'clis': [], 'workspaces': [], 'profiles': {}}))
    folder = tmp_path / 'proj'
    folder.mkdir()
    ok = run_cli('add', '--config', str(config), '--id', 'proj', '--path', str(folder), '--label', 'Projekt')
    assert ok.returncode == 0, ok.stderr
    assert config.stat().st_mode & 0o777 == 0o600
    assert json.loads(config.read_text())['workspaces'] == [{'id': 'proj', 'label': 'Projekt', 'path': str(folder.resolve())}]
    assert str(folder.resolve()) in run_cli('list', '--config', str(config)).stdout
    again = run_cli('add', '--config', str(config), '--id', 'proj', '--path', str(tmp_path))
    assert again.returncode == 3 and json.loads(config.read_text())['workspaces'][0]['label'] == 'Projekt'
    for bad in ['/', os.path.expanduser('~'), 'relativ', str(tmp_path / 'fehlt')]:
        assert run_cli('add', '--config', str(config), '--id', 'x', '--path', bad).returncode == 2, bad
    assert run_cli('add', '--config', str(config), '--id', 'bad id!', '--path', str(folder)).returncode == 2
    assert len(json.loads(config.read_text())['workspaces']) == 1
    assert not [p for p in tmp_path.iterdir() if p.name.startswith('.config-')]
