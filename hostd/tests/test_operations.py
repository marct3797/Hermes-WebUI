import base64
import sqlite3
import subprocess
from dataclasses import dataclass

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def setup(tmp_path):
    from hostd.operations import router
    root = tmp_path / 'workspace'
    root.mkdir()
    profile = tmp_path / 'profile'
    profile.mkdir()
    app = FastAPI()
    app.state.settings = {'workspaces': [{'id': 'w', 'label': 'Work', 'path': str(root)}],
                          'profiles': [{'id': 'p', 'path': str(profile)}]}
    app.include_router(router)
    return TestClient(app), root, profile, app


def test_files_roundtrip_and_pdf(setup):
    client, root, _, _ = setup
    assert client.get('/v1/workspaces').json() == {'workspaces': [{'id': 'w', 'label': 'Work', 'is_git': False}]}
    for name, data in [('hello.txt', b'hello'), ('document.pdf', b'%PDF-1.7\x00test')]:
        result = client.post('/v1/files/upload', json={'workspace': 'w', 'path': name,
                            'content_base64': base64.b64encode(data).decode()})
        assert result.status_code == 200, result.text
        assert result.json()['size'] == len(data)
        assert client.get('/v1/files/download', params={'workspace': 'w', 'path': name}).content == data
    assert client.get('/v1/files', params={'workspace': 'w', 'path': 'hello.txt'}).json()['content'] == 'hello'
    assert client.get('/v1/files', params={'workspace': 'w', 'path': 'document.pdf'}).status_code == 415
    assert len(client.get('/v1/files?workspace=w').json()['entries']) == 2


@pytest.mark.parametrize('path', ['../escape', '/etc/passwd', '.env', '.env.local', '.git/config',
                                  'auth.json', 'config.yaml', 'id_rsa', '.ssh/key', 'credentials.json'])
def test_sensitive_paths_denied(setup, path):
    client, _, _, _ = setup
    assert client.get('/v1/files', params={'workspace': 'w', 'path': path}).status_code == 403
    assert client.post('/v1/files/upload', json={'workspace': 'w', 'path': path,
                       'content_base64': 'YQ=='}).status_code == 403


def test_symlinks_overwrite_limits_and_bad_encoding(setup, tmp_path):
    client, root, _, _ = setup
    (root / 'existing.txt').write_text('keep')
    (root / 'link').symlink_to(tmp_path)
    for path, value, expected in [('existing.txt', 'YQ==', 409), ('link/out.txt', 'YQ==', 403),
                                  ('new.txt', '!!!', 400), ('big.txt', base64.b64encode(b'x' * (1048576 + 1)).decode(), 413)]:
        assert client.post('/v1/files/upload', json={'workspace': 'w', 'path': path,
                           'content_base64': value}).status_code == expected
    assert (root / 'existing.txt').read_text() == 'keep'
    assert client.get('/v1/files', params={'workspace': 'unknown'}).status_code == 404


def test_git_redacts_remote_secrets_and_sensitive_diff(setup):
    client, root, _, _ = setup
    def git(*args):
        return subprocess.run(['git', *args], cwd=root, check=True, capture_output=True)
    git('init')
    git('config', 'user.name', 'Synthetic')
    git('config', 'user.email', 'test@example.invalid')
    (root / 'hello.txt').write_text('before\n')
    (root / '.env').write_text('PRIVATE=never-disclose-value\n')
    (root / ':(glob)*').write_text('safe filename\n')
    git('add', '.')
    git('commit', '-m', 'fixture')
    git('remote', 'add', 'origin', 'https://user:remote-secret@example.invalid/repo?token=query-secret')
    git('remote', 'add', 'ssh', 'ssh://user:ssh-password@example.invalid/repo')
    (root / 'hello.txt').write_text('after\nAuthorization: Bearer header-secret\n')
    (root / ':(glob)*').write_text('modified safe filename\n')
    (root / '.env').write_text('PRIVATE=do-not-expose-value\n')
    result = client.get('/v1/git?workspace=w')
    assert result.status_code == 200, result.text
    assert 'after' in result.json()['diff']
    for secret in ['remote-secret', 'query-secret', 'header-secret', 'do-not-expose-value',
                   'never-disclose-value', 'ssh-password']:
        assert secret not in result.text
    assert result.json()['remotes'][0]['url'] == 'https://example.invalid/repo'


def test_session_fulltext_readonly_and_unavailable(setup):
    client, _, profile, _ = setup
    missing = client.get('/v1/search?q=needle').json()
    assert missing['results'] == [] and missing['warnings']
    db = profile / 'state.db'
    with sqlite3.connect(db) as conn:
        conn.executescript("CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT);"
                           "CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT);"
                           "CREATE VIRTUAL TABLE messages_fts USING fts5(content);")
        conn.execute('INSERT INTO sessions VALUES (?, ?)', ('session', 'Not a title match'))
        conn.execute('INSERT INTO messages VALUES (?, ?, ?, ?)', (1, 'session', 'user', 'body needle token=synthetic-secret'))
        conn.execute('INSERT INTO messages_fts(rowid,content) VALUES (?, ?)', (1, 'body needle token=synthetic-secret'))
    before = db.read_bytes()
    result = client.get('/v1/search?q=needle')
    assert result.status_code == 200, result.text
    assert result.json()['results'][0]['session_id'] == 'session'
    assert 'synthetic-secret' not in result.text
    assert db.read_bytes() == before
    assert client.get('/v1/search?q=%22%20OR%20%2A').status_code == 200


def test_management_unconfigured_and_allowlist(setup):
    client, _, profile, app = setup
    (profile / 'skills' / 'example').mkdir(parents=True)
    (profile / 'skills' / 'example' / 'SKILL.md').write_text('---\nname: example\n---\nSynthetic')
    (profile / 'config.yaml').write_text('mcp_servers:\n  sample:\n    url: https://user:private@example.invalid/?token=private\n    env:\n      KEY: private\n')
    overview = client.get('/v1/manage')
    assert overview.status_code == 200
    assert overview.json()['profiles'] == [{'id': 'p'}]
    assert client.get('/v1/manage/p/skills').json()['items'][0]['id'] == 'example'
    mcp = client.get('/v1/manage/p/mcp')
    assert mcp.json()['items'] == [{'id': 'sample', 'enabled': True}]
    assert 'private' not in mcp.text
    assert client.get('/v1/manage/p/kanban').json()['available'] is False
    assert client.get('/v1/manage/p/plugins').json()['available'] is False
    for kind, action, target in [('plugins', 'remove', 'sample'), ('mcp', 'install', 'https://evil.invalid'),
                                  ('skills', 'install', '../evil')]:
        assert client.post(f'/v1/manage/p/{kind}/{action}', json={'id': target}).status_code in (403, 501)
    assert client.get('/v1/manage/p/unknown').status_code == 404
    assert client.get('/v1/manage/unknown/skills').status_code == 404


def test_log_redaction_and_bound(setup):
    client, _, profile, _ = setup
    (profile / 'logs').mkdir()
    (profile / 'logs' / 'agent.log').write_text('normal\n' * 20000 + 'Authorization: Bearer synthetic-secret\napi_key=hidden\nhttps://u:pw@example.invalid/?code=private\n')
    result = client.get('/v1/manage/p/logs')
    assert result.status_code == 200
    assert result.json()['truncated']
    assert len(result.json()['content']) <= 65536
    for secret in ['synthetic-secret', 'hidden', 'pw', 'private']:
        assert secret not in result.text


def test_native_runner_bounds_timeout_and_invalid_redaction(tmp_path):
    import sys
    from hostd.native import run, redact
    from fastapi import HTTPException
    output, truncated, _ = run([sys.executable, '-c', "print('x'*100000)"], cwd=tmp_path, limit=128)
    assert truncated and len(output) == 128
    with pytest.raises(HTTPException) as failure:
        run([sys.executable, '-c', 'import time; time.sleep(5)'], cwd=tmp_path, timeout=0.1)
    assert failure.value.status_code == 504
    assert 'quoted-secret' not in redact('{"token": "quoted-secret"}')


def test_special_files_hidden_roots_and_binary_preview(setup):
    import os
    client, root, _, _ = setup
    os.mkfifo(root / 'pipe')
    assert client.get('/v1/files?workspace=w&path=pipe').status_code == 403
    (root / '.codex').mkdir()
    (root / '.codex' / 'settings.json').write_text('private')
    assert client.get('/v1/files?workspace=w&path=.codex/settings.json').status_code == 403
    (root / 'invalid.txt').write_bytes(b'\xff' + b'x' * 100000)
    assert client.get('/v1/files?workspace=w&path=invalid.txt').status_code == 415


def test_plugin_actions_fixed_argv_and_readback(setup, monkeypatch):
    from hostd import native
    client, _, profile, app = setup
    app.state.settings.update(hermes_command=['/reviewed/hermes'], reviewed_catalog=[
        {'id': 'sample', 'kind': 'plugins', 'reviewed': True, 'url': 'https://github.com/NousResearch/hermes-agent'}])
    app.state.settings['profiles'][0].update(allow_management=True, allowed_plugins=['sample'])
    state = []
    calls = []
    def run(argv, **kwargs):
        import json
        calls.append(argv)
        assert kwargs['env']['HERMES_HOME'] == str(profile)
        if argv[1:] == ['plugins', 'list', '--json']:
            return json.dumps(state), False, 0
        if argv[1:4] == ['plugins', 'install', 'sample']:
            assert argv[4:] == ['--no-deps', '--no-enable']
            state.append({'name': 'sample', 'status': 'disabled'})
        elif argv[1:4] == ['plugins', 'enable', 'sample']:
            assert argv[4:] == ['--no-allow-tool-override']
            state[0]['status'] = 'enabled'
        elif argv[1:4] == ['plugins', 'disable', 'sample']:
            state[0]['status'] = 'disabled'
        else:
            pytest.fail('Unexpected command')
        return '', False, 0
    monkeypatch.setattr(native, 'run', run)
    for action in ['install', 'enable', 'disable']:
        response = client.post(f'/v1/manage/p/plugins/{action}', json={'id': 'sample'})
        assert response.status_code == 200, response.text
    assert len(calls) == 9
    assert client.post('/v1/manage/p/plugins/install', json={'id': 'unknown'}).status_code == 403
    assert client.post('/v1/manage/p/plugins/install', json={'id': 'sample', 'url': 'https://evil.invalid'}).status_code == 422
    def no_change(argv, **kwargs):
        import json
        return (json.dumps(state), False, 0) if argv[2] == 'list' else ('', False, 0)
    monkeypatch.setattr(native, 'run', no_change)
    assert client.post('/v1/manage/p/plugins/enable', json={'id': 'sample'}).status_code == 409


def test_real_native_kanban_api_on_synthetic_db(setup):
    from pathlib import Path
    client, _, profile, app = setup
    source = Path('/home/user/.hermes/hermes-agent')
    import sys
    python = Path(sys.executable)
    if not (source / 'hermes_cli' / 'kanban_db.py').exists():
        pytest.skip('Local upstream source not available')
    db = profile / 'kanban.db'
    with sqlite3.connect(db) as conn:
        conn.execute('''CREATE TABLE tasks(id TEXT, title TEXT, body TEXT, assignee TEXT, status TEXT,
                     priority INTEGER, created_by TEXT, created_at INTEGER, started_at INTEGER,
                     completed_at INTEGER, workspace_kind TEXT, workspace_path TEXT, claim_lock TEXT,
                     claim_expires INTEGER, tenant TEXT)''')
        conn.execute("INSERT INTO tasks VALUES ('task','Native title',NULL,NULL,'todo',0,NULL,1,NULL,NULL,'scratch',NULL,NULL,NULL,NULL)")
    before = db.read_bytes()
    app.state.settings.update(native_source=str(source), native_python=str(python))
    app.state.settings['profiles'][0]['kanban_db'] = str(db)
    response = client.get('/v1/manage/p/kanban')
    assert response.status_code == 200, response.text
    assert response.json()['available'], response.text
    assert response.json()['items'][0]['title'] == 'Native title'
    assert db.read_bytes() == before


def test_git_unborn_repository(setup):
    client, root, _, _ = setup
    subprocess.run(['git', 'init'], cwd=root, check=True, capture_output=True)
    response = client.get('/v1/git?workspace=w')
    assert response.status_code == 200, response.text
    assert response.json()['diff'] == ''


def test_git_without_repository_is_200_with_reason(setup):
    client = setup[0]
    response = client.get('/v1/git?workspace=w')
    assert response.status_code == 200
    assert response.json() == {'repository': False, 'reason': 'Kein Git-Repository in diesem Arbeitsordner'}


def test_real_native_plugin_listing_on_temporary_profile(setup):
    from pathlib import Path
    client, _, _, app = setup
    binary = Path('/home/user/.local/bin/hermes')
    if not binary.exists():
        pytest.skip('Local Hermes CLI unavailable')
    app.state.settings['hermes_command'] = [str(binary)]
    response = client.get('/v1/manage/p/plugins')
    assert response.status_code == 200
    assert response.json()['available'], response.text
    assert isinstance(response.json()['items'], list)
    assert response.json()['actions'] == []


def test_dataclass_settings_and_bounded_preview(setup):
    client, root, _, app = setup
    @dataclass
    class Workspace:
        id: str
        label: str
        path: str
    @dataclass
    class Settings:
        workspaces: list
    app.state.settings = Settings([Workspace('w', 'Work', str(root))])
    (root / 'big.txt').write_text('x' * 100000)
    data = client.get('/v1/files?workspace=w&path=big.txt').json()
    assert data['truncated'] and len(data['content']) <= 65536


def test_git_modes_split_staged_unstaged_and_log(setup):
    client, root, _, _ = setup
    def git(*args):
        return subprocess.run(['git', *args], cwd=root, check=True, capture_output=True)
    git('init')
    git('config', 'user.name', 'Synthetic')
    git('config', 'user.email', 'test@example.invalid')
    (root / 'a.txt').write_text('one\n')
    (root / 'b.txt').write_text('one\n')
    git('add', '.')
    git('commit', '-m', 'erster Stand')
    (root / 'a.txt').write_text('staged-change\n')
    git('add', 'a.txt')
    (root / 'b.txt').write_text('unstaged-change\n')
    staged = client.get('/v1/git', params={'workspace': 'w', 'mode': 'staged'}).json()
    assert staged['mode'] == 'staged' and 'staged-change' in staged['diff'] and 'unstaged-change' not in staged['diff']
    plain = client.get('/v1/git', params={'workspace': 'w', 'mode': 'diff'}).json()
    assert 'unstaged-change' in plain['diff'] and 'staged-change\n' not in plain['diff'].replace('unstaged-change', '')
    log = client.get('/v1/git', params={'workspace': 'w', 'mode': 'log', 'n': 3}).json()
    assert 'erster Stand' in log['log'] and 'diff' not in log
    assert client.get('/v1/git', params={'workspace': 'w', 'mode': 'log', 'n': 11}).status_code == 422
    assert client.get('/v1/git', params={'workspace': 'w', 'mode': 'x'}).status_code == 422
