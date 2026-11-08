"""BFF: Tresor und Secrets-Anbieter über den Host-Dienst. Werte gehen nie zurück zum Browser; Schreiben mit frischer Anmeldung, Wort und Rücklesen."""
import pytest
from fastapi import FastAPI, HTTPException

from tests.test_memfiles_bff import TOKEN, logged

BASE = "/bff/h/server/hermes/default"
SEEN: list = []


def hostd(mode="ok"):
    app = FastAPI()
    state = {"items": [{"id": "vault_aaa", "kind": "login", "label": "GitHub", "origin": "https://github.com", "identifier": "a@b.de", "identifier_type": "email", "created_at": "t", "secret": "LEAK"}],
             "enabled": True, "refs": {}}

    def fail(code):
        raise HTTPException(code, "intern: /home/geheim")

    @app.get("/v1/profiles/{profile}/vault")
    async def lst(profile: str):
        if mode == "old":
            fail(404)
        if mode == "forbidden":
            fail(403)
        return {"items": state["items"], "key_storage": "file"}

    @app.post("/v1/profiles/{profile}/vault")
    async def add(profile: str, body: dict):
        SEEN.append(body)
        if mode == "bad":
            fail(422)
        item = {"id": "vault_new", "kind": body["kind"], "label": body["label"], "origin": body["origin"], "created_at": "t"}
        if mode != "drop":
            state["items"].append(item)
        return {"ok": True, "item": item}

    @app.delete("/v1/profiles/{profile}/vault/{item}")
    async def rm(profile: str, item: str):
        if mode != "keep":
            state["items"] = [i for i in state["items"] if i["id"] != item]
        return {"ok": True}

    @app.post("/v1/profiles/{profile}/secrets")
    async def secrets(profile: str, body: dict):
        SEEN.append(body)
        missing = body["action"] == "remove" and body["env_var"] not in state["refs"]
        if body["action"] == "disable" and mode != "keep":
            state["enabled"] = False
        if body["action"] == "set" and mode != "keep":
            state["refs"][body["env_var"]] = body["reference"]
        if body["action"] == "remove" and mode != "keep":
            state["refs"].pop(body["env_var"], None)
        rows = "\n".join(f"{k} {v}" for k, v in state["refs"].items())
        if mode == "status_fail" and body["action"] == "status":
            return {"ok": False, "output": "Traceback", "truncated": False}
        if missing:
            return {"ok": False, "output": "not set", "truncated": False}
        return {"ok": True, "output": f"Enabled   {'yes' if state['enabled'] else 'no'}\n{rows}", "truncated": False}
    return app


def make(tmp_path, make_settings, monkeypatch, mode="ok"):
    monkeypatch.setenv("TEST_HOSTD", TOKEN)
    SEEN.clear()
    return logged(tmp_path, make_settings, hostd(mode))


def stale(c):
    from app.auth import SESSION_COOKIE
    c.app.state.sessions.get(c.cookies.get(SESSION_COOKIE)).auth_time = 0


def test_list_returns_metadata_only(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch):
        body = c.get(f"{BASE}/vault").json()
        assert body["key_storage"] == "file" and body["items"][0]["label"] == "GitHub"
        assert "LEAK" not in str(body) and "secret" not in body["items"][0]


@pytest.mark.parametrize("mode,status", [("old", 404), ("forbidden", 403)])
def test_hostd_problems_become_clear_errors(tmp_path, make_settings, monkeypatch, mode, status):
    for c in make(tmp_path, make_settings, monkeypatch, mode):
        r = c.get(f"{BASE}/vault")
        assert r.status_code == status and "geheim" not in r.text


LOGIN = {"kind": "login", "label": "Forgejo", "origin": "https://git.example.org", "identifier": "marc", "identifier_type": "username", "password": "Pa$$w0rd-geheim"}


def test_add_login_is_verified_audited_without_secret_and_needs_fresh_login(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch):
        r = c.post(f"{BASE}/vault", json=LOGIN)
        assert r.status_code == 200 and r.json()["item"]["label"] == "Forgejo" and "Pa$$w0rd" not in r.text
        assert SEEN[0]["secret"] == {"identifier_type": "username", "identifier": "marc", "password": "Pa$$w0rd-geheim"}
        log = c.audit_file.read_text()
        assert "vault.add" in log and "Pa$$w0rd" not in log and "Forgejo" not in log
        stale(c)
        assert c.post(f"{BASE}/vault", json=LOGIN).status_code == 401 and len(SEEN) == 1


def test_add_payment_only_known_fields(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch):
        ok = {"kind": "payment", "label": "Karte", "origin": "https://shop.example", "fields": {"card_number": "4111", "exp_month": "1", "exp_year": "30", "cvc": "123"}}
        assert c.post(f"{BASE}/vault", json=ok).status_code == 200
        assert c.post(f"{BASE}/vault", json={**ok, "fields": {"evil": "x"}}).status_code == 422
        assert c.post(f"{BASE}/vault", json={**ok, "fields": {}}).status_code == 422
        assert c.post(f"{BASE}/vault", json={**LOGIN, "password": ""}).status_code == 422
        assert c.post(f"{BASE}/vault", json={**LOGIN, "x": 1}).status_code == 422


def test_add_not_taken_over_is_502_and_audited(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch, "drop"):
        assert c.post(f"{BASE}/vault", json=LOGIN).status_code == 502
        assert "verified" in c.audit_file.read_text()


def test_remove_needs_the_label_and_is_read_back(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch):
        assert c.delete(f"{BASE}/vault/vault_aaa").status_code == 422
        assert c.delete(f"{BASE}/vault/vault_aaa", params={"confirm": "falsch"}).status_code == 422
        assert c.delete(f"{BASE}/vault/vault_nix", params={"confirm": "x"}).status_code == 404
        assert c.delete(f"{BASE}/vault/vault_aaa", params={"confirm": "GitHub"}).json() == {"ok": True}
        assert c.get(f"{BASE}/vault").json()["items"] == []
    for c in make(tmp_path, make_settings, monkeypatch, "keep"):
        assert c.delete(f"{BASE}/vault/vault_aaa", params={"confirm": "GitHub"}).status_code == 502


def test_secrets_status_and_sync(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch):
        r = c.post(f"{BASE}/secrets/bitwarden/status").json()
        assert r["enabled"] is True and "Enabled" in r["output"]
        assert c.post(f"{BASE}/secrets/bitwarden/sync").json()["ok"] is True
        assert c.post(f"{BASE}/secrets/other/status").status_code == 422


def test_secrets_disable_set_remove(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch):
        url = f"{BASE}/secrets/onepassword/change"
        assert c.post(url, json={"action": "disable"}).status_code == 422
        assert c.post(url, json={"action": "set", "env_var": "OPENAI_API_KEY", "reference": "op://Private/OpenAI/api key"}).json()["ok"] is True
        assert c.post(url, json={"action": "remove", "env_var": "OPENAI_API_KEY"}).status_code == 422
        assert c.post(url, json={"action": "remove", "env_var": "OPENAI_API_KEY", "confirm": "OPENAI_API_KEY"}).json()["ok"] is True
        assert c.post(url, json={"action": "disable", "confirm": "ausschalten"}).json()["enabled"] is False
        assert c.post(url, json={"action": "set", "env_var": "kaputt", "reference": "op://x"}).status_code == 422
        assert c.post(url, json={"action": "set", "env_var": "A", "reference": "https://evil"}).status_code == 422
        assert c.post(f"{BASE}/secrets/bitwarden/change", json={"action": "set", "env_var": "A", "reference": "op://x/y/z"}).status_code == 422
        log = c.audit_file.read_text()
        assert "secrets.set" in log and "verified" in log and "OPENAI_API_KEY" not in log and "op://" not in log


def test_secrets_change_not_taken_over_is_502(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch, "keep"):
        assert c.post(f"{BASE}/secrets/onepassword/change", json={"action": "disable", "confirm": "ausschalten"}).status_code == 502
        stale(c)
        assert c.post(f"{BASE}/secrets/onepassword/change", json={"action": "disable", "confirm": "ausschalten"}).status_code == 401


def test_remove_of_a_missing_mapping_is_404(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch):
        r = c.post(f"{BASE}/secrets/onepassword/change", json={"action": "remove", "env_var": "NOPE", "confirm": "NOPE"})
        assert r.status_code == 404


def test_unreadable_status_never_counts_as_proof(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch, "status_fail"):
        for body in ({"action": "disable", "confirm": "ausschalten"}, {"action": "set", "env_var": "A", "reference": "op://x/y/z"},
                     {"action": "remove", "env_var": "A", "confirm": "A"}):
            assert c.post(f"{BASE}/secrets/onepassword/change", json=body).status_code == 502, body


def test_sync_needs_fresh_login(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch):
        stale(c)
        assert c.post(f"{BASE}/secrets/bitwarden/sync").status_code == 401
        assert not SEEN


def test_references_with_brackets_or_control_characters_are_refused(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch):
        for ref in ("op://v/i/f[/x]", "op://v/i/f\u2028x", "op://" + "a" * 130):
            assert c.post(f"{BASE}/secrets/onepassword/change", json={"action": "set", "env_var": "A", "reference": ref}).status_code == 422, ref
        assert not SEEN


def test_payment_and_address_need_hermes_required_fields(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch):
        r = c.post(f"{BASE}/vault", json={"kind": "payment", "label": "K", "fields": {"card_number": "4111"}})
        assert r.status_code == 422 and "exp_month" in r.text and not SEEN
        ok = c.post(f"{BASE}/vault", json={"kind": "address", "label": "Zuhause", "fields": {"address_line1": "x", "city": "y", "postal_code": "1", "country": "DE"}})
        assert ok.status_code == 200


def test_failed_write_attempts_are_audited(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch, "bad"):
        assert c.post(f"{BASE}/vault", json=LOGIN).status_code == 422
        log = c.audit_file.read_text()
        assert "vault.add" in log and "422" in log and "Pa$$w0rd" not in log
