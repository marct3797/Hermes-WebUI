import json
import stat
import sys

import pytest
from fastapi.testclient import TestClient

HEAD = {'Authorization': 'Bearer ' + 't' * 40}
FORMATS = {  # id: (angemeldet, abgemeldet, Muell)
    'codex': ('echo "Logged in using ChatGPT"', 'echo "Not logged in"; exit 1', 'echo hallo'),
    'claude': ('echo \'{"loggedIn": true, "authMethod": "claude.ai", "email": "x@y.z"}\'',
               'echo \'{"loggedIn": false}\'; exit 1', 'echo "<html>"'),
    'opencode': ('printf "\\033[90mCredentials\\n 1 credentials\\n Environment\\n 0 environment variables\\n"',
                 'printf "Credentials\\n 0 credentials\\n Environment\\n 0 environment variables\\n"', 'echo ?'),
    'agy': ('printf "Fetching...\\nm1\\tModell 1\\n"', 'echo "Error: not signed in" >&2; exit 1', None),
}


def fake(tmp_path, name, body):
    path = tmp_path / name
    path.write_text('#!/bin/sh\n' + body + '\n')
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return [str(path)]


def client(tmp_path, monkeypatch, overrides, ids=None):
    from hostd.config import Settings
    from hostd.main import create_app
    monkeypatch.setenv('HERMES_HOSTD_TOKEN', 't' * 40)
    monkeypatch.setenv('HOME', str(tmp_path))  # kein echtes Token fuer agy
    ids = ids or list(overrides)
    settings = Settings.from_dict(dict(clis=[{'id': i, 'label': i, 'command': [sys.executable]} for i in ids]))
    settings.probe_overrides = overrides
    return TestClient(create_app(settings))


def states(c, query='?refresh=1'):
    return {e['id']: e for e in c.get('/v1/auth' + query, headers=HEAD).json()['clis']}


def test_four_formats_signed_in(tmp_path, monkeypatch):
    ov = {i: fake(tmp_path, i, v[0]) for i, v in FORMATS.items()}
    with client(tmp_path, monkeypatch, ov) as c:
        s = states(c)
    assert {i: e['state'] for i, e in s.items()} == dict.fromkeys(FORMATS, 'signed_in')
    assert s['codex']['method'] == 'ChatGPT' and s['claude']['method'] == 'claude.ai'
    assert s['opencode']['method'] == 'Zugangsdaten'
    assert 'x@y.z' not in json.dumps(s)


def test_signed_out_and_garbage(tmp_path, monkeypatch):
    out = {i: fake(tmp_path, i, v[1]) for i, v in FORMATS.items()}
    with client(tmp_path, monkeypatch, out) as c:
        assert {i: e['state'] for i, e in states(c).items()} == dict.fromkeys(FORMATS, 'signed_out')
    junk = {i: fake(tmp_path, i + 'j', v[2]) for i, v in FORMATS.items() if v[2]}
    with client(tmp_path, monkeypatch, junk) as c:
        s = states(c)
    assert {e['state'] for e in s.values()} == {'unknown'} and all(e['reason'] for e in s.values())


def test_opencode_environment_only(tmp_path, monkeypatch):
    ov = {'opencode': fake(tmp_path, 'oc', 'printf "0 credentials\\n2 environment variables\\n"')}
    with client(tmp_path, monkeypatch, ov) as c:
        e = states(c)['opencode']
    assert (e['state'], e['method']) == ('signed_in', 'Umgebungsvariable')


def test_timeout_missing_and_unknown_cli(tmp_path, monkeypatch):
    import hostd.auth as auth
    monkeypatch.setattr(auth, 'TIMEOUT', 0.3)
    ov = {'codex': fake(tmp_path, 'slow', 'sleep 5')}
    with client(tmp_path, monkeypatch, ov, ['codex', 'nope', 'claude']) as c:
        s = states(c)
    assert s['codex']['state'] == 'unknown' and 'Zeit' in s['codex']['reason']
    assert s['nope']['reason'] == 'Kein Statusbefehl bekannt'
    assert s['claude']['state'] == 'unknown'  # sys.executable hat kein "auth status": nie raten


def test_get_without_refresh_never_starts_a_probe(tmp_path, monkeypatch):
    """Seitenaufrufe lesen nur den Cache: ein Statusbefehl kann sonst den Schluesselbund-Dialog des Betriebssystems ausloesen."""
    counter = tmp_path / 'n'
    ov = {i: fake(tmp_path, i, f'echo x >> {counter}; ' + v[0]) for i, v in FORMATS.items()}
    with client(tmp_path, monkeypatch, ov) as c:
        s = states(c, '')
        assert not counter.exists()
    assert {i: e['state'] for i, e in s.items()} == dict.fromkeys(FORMATS, 'unknown')
    assert all(e['reason'] == 'Noch nicht geprüft' and e['checked_at'] is None and e['method'] is None for e in s.values())


def test_cache_refresh_rate_limit_and_info(tmp_path, monkeypatch):
    import hostd.auth as auth
    counter = tmp_path / 'n'
    ov = {'codex': fake(tmp_path, 'c', f'echo x >> {counter}; echo "Logged in using ChatGPT"')}
    lines = lambda: len(counter.read_text().splitlines()) if counter.exists() else 0
    with client(tmp_path, monkeypatch, ov) as c:
        assert c.get('/v1/info', headers=HEAD).json()['clis'][0]['authenticated'] is None
        states(c, ''); states(c, '')
        assert lines() == 0  # einfaches GET prueft nie
        states(c, '?refresh=1')
        assert lines() == 1
        assert states(c, '')['codex']['state'] == 'signed_in' and lines() == 1  # GET liefert den Cache, auch ohne TTL
        states(c, '?refresh=1')
        assert lines() == 1  # Rate-Limit 10 s
        monkeypatch.setattr(auth, 'MIN_REFRESH', 0)
        states(c, '?refresh=1')
        assert lines() == 2
        assert c.get('/v1/info', headers=HEAD).json()['clis'][0]['authenticated'] is True
        assert c.get('/v1/auth').status_code == 401


def test_config_file_cannot_set_probe_commands(tmp_path, monkeypatch):
    from hostd.config import Settings
    cfg = tmp_path / 'c.json'
    cfg.write_text(json.dumps({'probe_overrides': {'codex': ['/bin/id']}}))
    assert Settings.load(cfg).probe_overrides == {}
