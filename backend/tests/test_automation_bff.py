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


def test_there_is_no_write_route(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch):
        assert c.post(BASE_URL, json={}).status_code in (404, 405)
        assert c.delete(BASE_URL).status_code in (404, 405)
