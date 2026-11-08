"""BFF: Distributionen nur aus freigegebenen Quellen, mit Vorschau, Prüfsumme, frischer Anmeldung und eingetipptem Namen."""
import pytest
from fastapi import FastAPI, HTTPException

from tests.test_memfiles_bff import TOKEN, logged

BASE = "/bff/h/server/hermes/default/distributions"
DIGEST = "a" * 64
SEEN: list = []


def hostd(mode="ok"):
    app = FastAPI()

    @app.get("/v1/profiles/{profile}/distributions")
    async def sources(profile: str):
        return {"sources": [{"id": "team", "label": "Team", "source": "https://git.example.org/team/profile.git", "token": "LEAK"}]}

    @app.post("/v1/profiles/{profile}/distributions/{action}")
    async def act(profile: str, action: str, body: dict):
        SEEN.append((action, body))
        if mode == "changed":
            raise HTTPException(409, "intern /home/x")
        if action == "preview":
            return {"preview": {"name": "scout", "version": "1.0.0", "files": ["SOUL.md", "mcp.json"], "file_count": 2, "has_mcp": True, "has_cron": False,
                                "existing": False, "digest": DIGEST, "env_requires": [], "evil": "x"}}
        name = body.get("name") or body.get("profile")
        return {"done": {"name": name, "version": "1.0.0" if mode != "wrong" else None, "digest": DIGEST}}
    return app


def make(tmp_path, make_settings, monkeypatch, mode="ok"):
    monkeypatch.setenv("TEST_HOSTD", TOKEN)
    SEEN.clear()
    return logged(tmp_path, make_settings, hostd(mode))


def stale(c):
    from app.auth import SESSION_COOKIE
    c.app.state.sessions.get(c.cookies.get(SESSION_COOKIE)).auth_time = 0


def test_sources_and_preview_are_filtered(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch):
        assert c.get(BASE).json() == {"sources": [{"id": "team", "label": "Team", "source": "https://git.example.org/team/profile.git"}]}
        p = c.post(f"{BASE}/preview", json={"source_id": "team", "name": "scout"}).json()["preview"]
        assert p["digest"] == DIGEST and p["has_mcp"] is True and "evil" not in p
        assert c.post(f"{BASE}/preview", json={"source_id": "team"}).status_code == 422
        assert c.post(f"{BASE}/preview", json={"source_id": "team", "name": "a", "profile": "b"}).status_code == 422
        assert c.post(f"{BASE}/preview", json={"source_id": "https://evil", "name": "scout"}).status_code == 422
        assert c.post(f"{BASE}/preview", json={"source_id": "team", "name": "../x"}).status_code == 422


def test_install_needs_name_digest_and_fresh_login_and_is_audited_without_content(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch):
        body = {"source_id": "team", "name": "scout", "digest": DIGEST, "confirm": "scout"}
        assert c.post(f"{BASE}/install", json={**body, "confirm": "anders"}).status_code == 422
        assert c.post(f"{BASE}/install", json={**body, "digest": "xyz"}).status_code == 422
        assert not SEEN
        r = c.post(f"{BASE}/install", json=body)
        assert r.status_code == 200 and r.json() == {"ok": True, "name": "scout", "version": "1.0.0"}
        assert SEEN == [("install", {"source_id": "team", "name": "scout", "digest": DIGEST, "force": False, "force_config": False})]
        log = c.audit_file.read_text()
        assert "distribution.install" in log and "scout" in log and "verified" in log and "git.example.org" not in log
        stale(c)
        assert c.post(f"{BASE}/install", json=body).status_code == 401 and len(SEEN) == 1


def test_update_targets_a_profile_and_needs_its_name(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch):
        body = {"source_id": "team", "profile": "scout", "digest": DIGEST, "confirm": "scout", "force_config": True}
        assert c.post(f"{BASE}/update", json={**body, "confirm": "x"}).status_code == 422
        assert c.post(f"{BASE}/update", json={**body, "profile": None, "name": "scout"}).status_code == 422
        assert c.post(f"{BASE}/update", json=body).json()["version"] == "1.0.0"
        assert SEEN[-1][1]["force_config"] is True


@pytest.mark.parametrize("mode,status", [("changed", 409), ("wrong", 502)])
def test_changed_source_and_unconfirmed_result(tmp_path, make_settings, monkeypatch, mode, status):
    for c in make(tmp_path, make_settings, monkeypatch, mode):
        r = c.post(f"{BASE}/install", json={"source_id": "team", "name": "scout", "digest": DIGEST, "confirm": "scout"})
        assert r.status_code == status and "/home" not in r.text
        assert "verified" in c.audit_file.read_text()
