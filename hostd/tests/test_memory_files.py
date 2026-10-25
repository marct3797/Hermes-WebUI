"""Hostseitige Gedaechtnisdateien: Lesen/Schreiben von MEMORY.md und USER.md je Profil."""
import hashlib
import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

EMPTY_SHA = hashlib.sha256(b'').hexdigest()


def setup(tmp_path):
    """hostd-App mit einem Profil, das auf ein isoliertes Verzeichnis zeigt."""
    from hostd.operations import router
    root = tmp_path / 'profiles' / 'p'
    (root / 'memories').mkdir(parents=True)
    app = FastAPI()
    app.state.settings = {'workspaces': [], 'profiles': [{'id': 'p', 'path': str(root)}]}
    app.include_router(router)
    return TestClient(app), root


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def test_list_shows_both_files_with_exists_flag(tmp_path):
    client, root = setup(tmp_path)
    (root / 'memories' / 'MEMORY.md').write_text('a')
    body = client.get('/v1/profiles/p/memory-files').json()
    assert [f['name'] for f in body['files']] == ['MEMORY.md', 'USER.md']
    names = {f['name']: f for f in body['files']}
    assert names['MEMORY.md']['exists'] is True and names['MEMORY.md']['size'] == 1
    assert names['USER.md']['exists'] is False and names['USER.md']['size'] == 0
    assert isinstance(names['MEMORY.md']['mtime'], float)


def test_read_missing_returns_empty_with_empty_sha(tmp_path):
    client, _ = setup(tmp_path)
    resp = client.get('/v1/profiles/p/memory-files/USER.md')
    assert resp.status_code == 200
    body = resp.json()
    assert body == {'name': 'USER.md', 'content': '', 'sha256': EMPTY_SHA, 'size': 0, 'mtime': 0.0}


def test_read_roundtrip(tmp_path):
    client, root = setup(tmp_path)
    (root / 'memories' / 'USER.md').write_text('hallo')
    body = client.get('/v1/profiles/p/memory-files/USER.md').json()
    assert body['content'] == 'hallo' and body['sha256'] == sha('hallo') and body['size'] == 5


def test_read_too_large_is_413(tmp_path):
    client, root = setup(tmp_path)
    (root / 'memories' / 'MEMORY.md').write_bytes(b'x' * (262144 + 1))
    assert client.get('/v1/profiles/p/memory-files/MEMORY.md').status_code == 413


def test_read_bad_names_and_profiles(tmp_path):
    client, _ = setup(tmp_path)
    assert client.get('/v1/profiles/p/memory-files/OTHER.md').status_code == 404
    assert client.get('/v1/profiles/p/memory-files/%2E%2E').status_code in (404, 422)
    assert client.get('/v1/profiles/fremd/memory-files').status_code == 404
    assert client.get('/v1/profiles/fremd/memory-files/MEMORY.md').status_code == 404


def test_write_new_file_without_memories_dir(tmp_path):
    from hostd.operations import router
    root = tmp_path / 'profiles' / 'q'
    root.mkdir(parents=True)
    app = FastAPI()
    app.state.settings = {'workspaces': [], 'profiles': [{'id': 'q', 'path': str(root)}]}
    client = TestClient(app)
    app.include_router(router)
    resp = client.put('/v1/profiles/q/memory-files/MEMORY.md', json={'content': 'neu', 'expected_sha256': EMPTY_SHA})
    assert resp.status_code == 200
    body = resp.json()
    assert body['sha256'] == sha('neu') and body['size'] == 3 and body['backup'] is False
    assert (root / 'memories' / 'MEMORY.md').read_text() == 'neu'
    assert (root / 'memories' / 'MEMORY.md').stat().st_mode & 0o777 == 0o600


def test_write_overwrite_needs_matching_sha(tmp_path):
    client, root = setup(tmp_path)
    (root / 'memories' / 'MEMORY.md').write_text('alt')
    assert client.put('/v1/profiles/p/memory-files/MEMORY.md', json={'content': 'x'}).status_code == 422
    assert client.put('/v1/profiles/p/memory-files/MEMORY.md',
                      json={'content': 'neu', 'expected_sha256': sha('anders')}).status_code == 409
    assert (root / 'memories' / 'MEMORY.md').read_text() == 'alt'
    assert client.put('/v1/profiles/p/memory-files/MEMORY.md',
                      json={'content': 'neu', 'expected_sha256': sha('falsch')}).status_code == 409


def test_write_creates_backup_and_keeps_five(tmp_path):
    client, root = setup(tmp_path)
    (root / 'memories' / 'MEMORY.md').write_text('v0')
    expected = sha('v0')
    for i in range(1, 8):
        resp = client.put('/v1/profiles/p/memory-files/MEMORY.md', json={'content': f'v{i}', 'expected_sha256': expected})
        assert resp.status_code == 200
        expected = resp.json()['sha256']
        assert resp.json()['backup'] is True
    backups = sorted(p.name for p in (root / 'memories').iterdir() if p.name.startswith('MEMORY.md.bak-'))
    assert len(backups) == 5
    assert (root / 'memories' / 'MEMORY.md').read_text() == 'v7'


def test_write_keeps_mode_and_verifies(tmp_path):
    client, root = setup(tmp_path)
    (root / 'memories' / 'MEMORY.md').write_text('eins\n')
    (root / 'memories' / 'MEMORY.md').chmod(0o640)
    read = client.get('/v1/profiles/p/memory-files/MEMORY.md').json()
    saved = client.put('/v1/profiles/p/memory-files/MEMORY.md', json={'content': 'zwei\n', 'expected_sha256': read['sha256']})
    assert saved.status_code == 200 and saved.json()['sha256'] == sha('zwei\n')
    assert (root / 'memories' / 'MEMORY.md').read_text() == 'zwei\n'
    assert (root / 'memories' / 'MEMORY.md').stat().st_mode & 0o777 == 0o640


def test_write_rejects_nul_and_oversize(tmp_path):
    client, root = setup(tmp_path)
    (root / 'memories' / 'MEMORY.md').write_text('alt')
    old = sha('alt')
    assert client.put('/v1/profiles/p/memory-files/MEMORY.md', json={'content': 'a\x00b', 'expected_sha256': old}).status_code == 422
    assert client.put('/v1/profiles/p/memory-files/MEMORY.md',
                      json={'content': 'x' * (262144 + 1), 'expected_sha256': old}).status_code == 422
    assert (root / 'memories' / 'MEMORY.md').read_text() == 'alt'


def test_write_symlink_escape_denied(tmp_path):
    client, root = setup(tmp_path)
    outside = tmp_path / 'outside.md'
    outside.write_text('geheim')
    (root / 'memories' / 'MEMORY.md').symlink_to(outside)
    assert client.get('/v1/profiles/p/memory-files/MEMORY.md').status_code == 403
    assert client.put('/v1/profiles/p/memory-files/MEMORY.md',
                      json={'content': 'x', 'expected_sha256': EMPTY_SHA}).status_code in (403, 404, 409)
    assert outside.read_text() == 'geheim'
    memlink = tmp_path / 'memlink'
    memlink.symlink_to(tmp_path / 'ziel')
    (tmp_path / 'ziel').mkdir(exist_ok=True)
    from hostd.operations import router as _router
    app = FastAPI()
    app.state.settings = {'workspaces': [], 'profiles': [{'id': 's', 'path': str(memlink)}]}
    app.include_router(_router)
    assert TestClient(app).get('/v1/profiles/s/memory-files').status_code == 403


def test_write_atomic_failure_leaves_original(tmp_path, monkeypatch):
    client, root = setup(tmp_path)
    (root / 'memories' / 'MEMORY.md').write_text('alt')
    import hostd.memory_files as mem
    real = mem.digest_of
    calls = []

    def racing(fd):
        calls.append(1)
        if len(calls) == 2:
            (root / 'memories' / 'MEMORY.md').write_text('fremd')
        return real(fd)
    monkeypatch.setattr(mem, 'digest_of', racing)
    assert client.put('/v1/profiles/p/memory-files/MEMORY.md',
                      json={'content': 'neu', 'expected_sha256': sha('alt')}).status_code == 409
    assert (root / 'memories' / 'MEMORY.md').read_text() == 'fremd'
    leftovers = [p.name for p in (root / 'memories').iterdir() if p.name.startswith('.hostd-tmp')]
    assert leftovers == []


def test_write_errors_carry_no_paths(tmp_path):
    client, root = setup(tmp_path)
    (root / 'memories' / 'MEMORY.md').symlink_to(tmp_path / 'nichts')
    for resp in (client.get('/v1/profiles/p/memory-files/MEMORY.md'),
                 client.get('/v1/profiles/xx/memory-files'),
                 client.get('/v1/profiles/p/memory-files/ANDERS.md')):
        assert str(root) not in resp.text and 'memories' not in resp.text.lower().replace('memory-files', '')


def test_write_rejects_invalid_utf8_on_disk(tmp_path):
    client, root = setup(tmp_path)
    (root / 'memories' / 'MEMORY.md').write_bytes(b'\xff\xfe ung\xc3\xbcltig')
    assert client.get('/v1/profiles/p/memory-files/MEMORY.md').status_code == 422
