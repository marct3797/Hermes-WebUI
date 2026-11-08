"""BFF: Ziele, Heartbeats und Schleifen kommen nur lesend vom Host-Dienst."""
import pytest
from fastapi import FastAPI, HTTPException

from tests.test_memfiles_bff import TOKEN, logged

BASE_URL = "/bff/h/server/hermes/default/automation"
ROWS = [{"kind": "goal", "session_id": "s1", "title": "Release", "text": "Alles grün", "status": "active", "turns_used": 2, "max_turns": 20},
        {"kind": "loop", "session_id": "s1", "title": "Release", "text": "Deploy", "status": "paused"},
        {"kind": "zufall", "session_id": "s2"}, "kaputt"]


def hostd(mode="ok"):
    app = FastAPI()

    @app.get("/v1/profiles/{profile}/automation")
    async def automation(profile: str):
        if mode == "old":
            raise HTTPException(404, "nope")
        if mode == "deny":
            raise HTTPException(403, "nein")
        if mode == "shape":
            return {"unknown": True}
        return {"items": ROWS, "truncated": False, "available": True}
    return app


def make(tmp_path, make_settings, monkeypatch, mode="ok"):
    monkeypatch.setenv("TEST_HOSTD", TOKEN)
    return logged(tmp_path, make_settings, hostd(mode))


def test_returns_only_known_kinds(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch):
        body = c.get(BASE_URL).json()
        assert [i["kind"] for i in body["items"]] == ["goal", "loop"] and body["available"] is True


@pytest.mark.parametrize("mode,status", [("old", 501), ("deny", 502), ("shape", 502)])
def test_hostd_problems_become_clear_errors(tmp_path, make_settings, monkeypatch, mode, status):
    for c in make(tmp_path, make_settings, monkeypatch, mode):
        assert c.get(BASE_URL).status_code == status


def test_host_without_daemon_is_reported(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch):
        r = c.get("/bff/h/nodaemon/hermes/default/automation")
        assert r.status_code in (404, 501, 502, 503)


POSTED: list = []


def writable(mode="ok"):
    app = hostd()

    @app.post("/v1/profiles/{profile}/automation")
    async def change(profile: str, body: dict):
        POSTED.append(body)
        codes = {"forbidden": 403, "notfound": 404, "refused": 409, "bad": 422, "notconfigured": 501, "timeout": 504}
        if mode in codes:
            raise HTTPException(codes[mode], "intern: /home/geheim")
        return {"ok": True, "kind": body["kind"], "action": body["action"], "status": "paused"}
    return app


def make_w(tmp_path, make_settings, monkeypatch, mode="ok"):
    monkeypatch.setenv("TEST_HOSTD", TOKEN)
    POSTED.clear()
    return logged(tmp_path, make_settings, writable(mode))


def test_change_is_forwarded_audited_without_text_and_needs_fresh_login(tmp_path, make_settings, monkeypatch):
    for c in make_w(tmp_path, make_settings, monkeypatch):
        r = c.post(BASE_URL, json={"session_id": "s1", "kind": "goal", "action": "set", "text": "Geheimes Ziel", "max_turns": 5})
        assert r.status_code == 200 and r.json() == {"ok": True, "kind": "goal", "action": "set", "status": "paused"}
        assert POSTED == [{"session_id": "s1", "kind": "goal", "action": "set", "text": "Geheimes Ziel", "max_turns": 5}]
        log = c.audit_file.read_text()
        assert "profile.automation" in log and "Geheimes Ziel" not in log
        from app.auth import SESSION_COOKIE
        c.app.state.sessions.get(c.cookies.get(SESSION_COOKIE)).auth_time = 0
        assert c.post(BASE_URL, json={"session_id": "s1", "kind": "goal", "action": "clear"}).status_code == 401
        assert len(POSTED) == 1


@pytest.mark.parametrize("bad", [{"kind": "loop", "action": "set", "text": "x"}, {"kind": "goal", "action": "set"}, {"kind": "heartbeat", "action": "set", "text": "x"},
                                 {"kind": "goal", "action": "kill"}, {"kind": "goal", "action": "clear", "extra": 1}])
def test_invalid_changes_never_reach_hostd(tmp_path, make_settings, monkeypatch, bad):
    for c in make_w(tmp_path, make_settings, monkeypatch):
        assert c.post(BASE_URL, json={"session_id": "s1", **bad}).status_code == 422
        assert POSTED == []
    assert c.post(BASE_URL, json={"session_id": "../x", "kind": "goal", "action": "clear"}).status_code == 422


@pytest.mark.parametrize("mode,status", [("forbidden", 403), ("notfound", 501), ("refused", 409), ("bad", 422), ("notconfigured", 501), ("timeout", 504)])
def test_hostd_refusals_become_german_hints_without_internals(tmp_path, make_settings, monkeypatch, mode, status):
    for c in make_w(tmp_path, make_settings, monkeypatch, mode):
        r = c.post(BASE_URL, json={"session_id": "s1", "kind": "goal", "action": "clear"})
        assert r.status_code == status and "geheim" not in r.text


def test_delete_route_does_not_exist(tmp_path, make_settings, monkeypatch):
    for c in make_w(tmp_path, make_settings, monkeypatch):
        assert c.delete(BASE_URL).status_code in (404, 405)
