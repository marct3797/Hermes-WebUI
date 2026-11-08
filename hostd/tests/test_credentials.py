"""Tresor und Secrets-Anbieter: feste Aufrufe, Geheimnisse nur über stdin, Flags je Profil. Hermes ist hier ein Ersatz (Paket `agent`, Skript `hermes`)."""
import json
import os
import stat
import sys

from fastapi import FastAPI
from fastapi.testclient import TestClient

STORE = '''
import json, os, uuid
class VaultError(Exception): pass
LOGIN_IDENTIFIER_TYPES = ("email", "phone", "username")
VAULT_KINDS = ("login", "payment", "address")
class Meta:
    def __init__(self, d): self.d = d
    def to_dict(self): return {k: v for k, v in self.d.items() if k != "secret"}
class Store:
    path = os.environ["FAKE_VAULT"]
    def _all(self):
        return json.load(open(self.path)) if os.path.exists(self.path) else []
    def key_location(self): return {"storage": "file", "path": "/home/secret/vault.key"}
    def list_items(self): return [Meta(r) for r in self._all()]
    def add_item(self, kind, label, secret, origin=None):
        if kind == "login" and not secret.get("password"): raise VaultError("login items require identifier and password")
        rec = {"id": "vault_" + uuid.uuid4().hex[:12], "kind": kind, "label": label, "origin": origin, "created_at": "now",
               "identifier": secret.pop("identifier", None), "identifier_type": secret.pop("identifier_type", None), "secret": secret}
        json.dump(self._all() + [rec], open(self.path, "w"))
        return Meta(rec)
    def remove_item(self, item_id):
        rest = [r for r in self._all() if r["id"] != item_id]
        found = len(rest) != len(self._all())
        json.dump(rest, open(self.path, "w"))
        return found
def get_vault_store(): return Store()
'''
HERMES = '''#!{python}
import os, sys
with open(os.environ["FAKE_LOG"], "a") as f:
    f.write(" ".join(sys.argv[1:]) + "|" + os.environ.get("NO_COLOR", "") + "\\n")
print("\\x1b[32mEnabled\\x1b[0m yes")
print("token abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH https://user:pw@example.org/x?k=1")
sys.exit(int(os.environ.get("FAKE_CODE", "0")))
'''


def setup(tmp_path, monkeypatch, vault=True, secrets=True, python=True):
    from hostd.operations import router
    pkg = tmp_path / 'src' / 'agent'
    pkg.mkdir(parents=True, exist_ok=True)
    (pkg / '__init__.py').write_text('')
    (pkg / 'vault_store.py').write_text(STORE)
    tool = tmp_path / 'hermes'
    tool.write_text(HERMES.format(python=sys.executable))
    tool.chmod(tool.stat().st_mode | stat.S_IEXEC)
    root = tmp_path / 'p'
    root.mkdir(exist_ok=True)
    monkeypatch.setenv('FAKE_VAULT', str(tmp_path / 'vault.json'))
    monkeypatch.setenv('FAKE_LOG', str(tmp_path / 'cli.log'))
    app = FastAPI()
    settings = {'workspaces': [], 'hermes_command': [str(tool)],
                'profiles': [{'id': 'p', 'path': str(root), 'allow_vault': vault, 'allow_secrets': secrets}]}
    if python:
        settings.update(native_python=sys.executable, native_source=str(tmp_path / 'src'))
    app.state.settings = settings
    app.include_router(router)
    return TestClient(app)


LOGIN = {'kind': 'login', 'label': 'GitHub', 'origin': 'https://github.com',
         'secret': {'identifier_type': 'email', 'identifier': 'a@b.de', 'password': 'S3cret-Pass'}}


def test_vault_roundtrip_never_returns_the_password(tmp_path, monkeypatch):
    c = setup(tmp_path, monkeypatch)
    r = c.post('/v1/profiles/p/vault', json=LOGIN)
    assert r.status_code == 200 and r.json()['item']['label'] == 'GitHub'
    listed = c.get('/v1/profiles/p/vault').json()
    assert [i['label'] for i in listed['items']] == ['GitHub'] and listed['key_storage'] == 'file'
    assert 'S3cret-Pass' not in json.dumps(listed) and 'S3cret-Pass' not in r.text and '/home/secret' not in json.dumps(listed)
    item = listed['items'][0]['id']
    assert c.delete(f'/v1/profiles/p/vault/{item}').json() == {'ok': True}
    assert c.get('/v1/profiles/p/vault').json()['items'] == []
    assert c.delete(f'/v1/profiles/p/vault/{item}').status_code == 404


def test_vault_needs_the_profile_flag_and_the_hermes_client(tmp_path, monkeypatch):
    assert setup(tmp_path, monkeypatch, vault=False).get('/v1/profiles/p/vault').status_code == 403
    assert setup(tmp_path, monkeypatch, python=False).get('/v1/profiles/p/vault').status_code == 501


def test_vault_refusal_from_hermes_is_422_and_input_is_checked(tmp_path, monkeypatch):
    c = setup(tmp_path, monkeypatch)
    bad = {**LOGIN, 'secret': {'identifier_type': 'email', 'identifier': 'a@b.de'}}
    assert c.post('/v1/profiles/p/vault', json=bad).status_code == 422
    assert c.post('/v1/profiles/p/vault', json={**LOGIN, 'secret': {'evil': 'x'}}).status_code == 422
    assert c.post('/v1/profiles/p/vault', json={**LOGIN, 'extra': 1}).status_code == 422
    assert c.delete('/v1/profiles/p/vault/..%2Fx').status_code in (404, 422)
    assert c.delete('/v1/profiles/p/vault/a b').status_code == 422


def test_password_goes_over_stdin_not_argv(tmp_path, monkeypatch):
    from hostd import native
    seen = []
    real = native.run

    def spy(argv, **kw):
        seen.append((list(argv), kw.get('stdin_data')))
        return real(argv, **kw)
    monkeypatch.setattr(native, 'run', spy)
    c = setup(tmp_path, monkeypatch)
    c.post('/v1/profiles/p/vault', json=LOGIN)
    argv, stdin = seen[-1]
    assert 'S3cret-Pass' not in ' '.join(argv) and b'S3cret-Pass' in stdin


def test_old_hermes_without_vault_store_is_426(tmp_path, monkeypatch):
    c = setup(tmp_path, monkeypatch)
    (tmp_path / 'src' / 'agent' / 'vault_store.py').unlink()
    assert c.get('/v1/profiles/p/vault').status_code == 426


def test_secrets_run_fixed_commands_with_clean_output(tmp_path, monkeypatch):
    c = setup(tmp_path, monkeypatch)
    r = c.post('/v1/profiles/p/secrets', json={'provider': 'bitwarden', 'action': 'status'})
    assert r.status_code == 200 and r.json()['ok'] is True
    out = r.json()['output']
    assert '\x1b' not in out and 'abcdefghijklmnopqrstuvwxyz0123456789' not in out
    assert 'user:pw' not in out and 'Enabled yes' in out
    assert (tmp_path / 'cli.log').read_text().strip() == 'secrets bitwarden status|1'


def test_secrets_set_and_remove_only_for_onepassword_with_checked_values(tmp_path, monkeypatch):
    c = setup(tmp_path, monkeypatch)
    ok = c.post('/v1/profiles/p/secrets', json={'provider': 'onepassword', 'action': 'set', 'env_var': 'OPENAI_API_KEY', 'reference': 'op://Private/OpenAI/api key'})
    assert ok.status_code == 200
    assert 'secrets onepassword set OPENAI_API_KEY op://Private/OpenAI/api key' in (tmp_path / 'cli.log').read_text()
    for body in ({'provider': 'bitwarden', 'action': 'set', 'env_var': 'A', 'reference': 'op://x/y/z'},
                 {'provider': 'onepassword', 'action': 'set', 'env_var': 'lower', 'reference': 'op://x/y/z'},
                 {'provider': 'onepassword', 'action': 'set', 'env_var': 'A', 'reference': 'https://evil'},
                 {'provider': 'onepassword', 'action': 'set', 'env_var': 'A', 'reference': 'op://x/y;rm -rf'},
                 {'provider': 'onepassword', 'action': 'set', 'env_var': 'A'},
                 {'provider': 'onepassword', 'action': 'rm'}, {'provider': 'x', 'action': 'status'}):
        assert c.post('/v1/profiles/p/secrets', json=body).status_code == 422, body


def test_secrets_flag_and_failure(tmp_path, monkeypatch):
    assert setup(tmp_path, monkeypatch, secrets=False).post('/v1/profiles/p/secrets', json={'provider': 'bitwarden', 'action': 'status'}).status_code == 403
    c = setup(tmp_path, monkeypatch)
    monkeypatch.setenv('FAKE_CODE', '1')
    r = c.post('/v1/profiles/p/secrets', json={'provider': 'bitwarden', 'action': 'sync'})
    assert r.status_code == 200 and r.json()['ok'] is False
