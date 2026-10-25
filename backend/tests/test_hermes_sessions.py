"""Sitzungen verwalten (Punkt 9): Statistik, Export, Aufräumen, Mehrfach-Löschen, Leere löschen.

Schranken des BFF (Hermes fragt bei Löschen nicht nach):
- Löschen immer mit frischer Anmeldung und mit der vorher gezeigten Anzahl als Bestätigung (Vorschau -> Zahl eintippen),
- Aufräumen nie ohne Altersgrenze von mindestens einem Tag (0 würde alles treffen), Mehrfach-Löschen höchstens 500 IDs,
- Ergebnis wird mit der Statistik gegengelesen; Inhalte der Sitzungen landen nie im Audit.
Import bleibt bewusst aus (fremde Verläufe einschleusen).
"""
import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import SESSION_COOKIE, User
from app.main import create_app
from devtools.mock_dashboard import create_mock as create_dashboard
from devtools.mock_hermes import create_mock
from tests.conftest import BASE, HDR, RouterTransport

S = f"{BASE}/hermes-sessions"
DAY = 86400


def seed(env, rows):
    env.dash.state.profiles["default"]["sessions"] = rows


def row(sid, age_days, messages=3, title="t", active=False):
    return {"id": sid, "title": title, "last_active": time.time() - age_days * DAY, "messages": messages, "source": "cli", "active": active}


@pytest.fixture
def env(tmp_path, make_settings):
    f = tmp_path / "s-hosts.json"
    rt = {"id": "hermes", "base_url": "http://hermes.test", "api_key": "k", "multiplex": True, "agents": ["default", "beta"], "dashboard": {"base_url": "http://dash.test"}}
    f.write_text(json.dumps({"hosts": [{"id": "server", "runtimes": [rt]}]}))
    dash = create_dashboard()
    settings = make_settings(hosts_file=f, auth_mode="oidc", oidc_issuer="https://id.test", oidc_client_id="t", oidc_client_secret="t", oidc_allowed_sub="user", public_url="http://testserver")
    app = create_app(settings, transport=RouterTransport({"hermes.test": httpx.ASGITransport(app=create_mock(delay=0)), "dash.test": httpx.ASGITransport(app=dash)}))
    with TestClient(app) as c:
        s = app.state.sessions.create(User("user", "Test"))
        s.auth_time = app.state.sessions.now()
        c.cookies.set(SESSION_COOKIE, s.id)
        c.headers.update(HDR)
        c.dash, c.audit_file = dash, settings.audit_file
        seed(c, [row("a1", 200, title="GEHEIMER-TITEL"), row("a2", 100), row("a3", 1), row("e1", 5, messages=0), row("act", 300, active=True)])
        yield c


def stale(env):
    env.app.state.sessions.get(env.cookies.get(SESSION_COOKIE)).auth_time = 0


def total(env):
    return env.get(f"{S}/stats").json()["total"]


def test_stats_counts_sessions_and_messages(env):
    b = env.get(f"{S}/stats").json()
    assert b["total"] == 5 and b["messages"] == 12 and isinstance(b["by_source"], dict)


def test_prune_preview_changes_nothing_and_reports_matches(env):
    r = env.post(f"{S}/prune/preview", json={"older_than_days": 90})
    assert r.status_code == 200 and r.json()["matched"] == 2 and r.json()["skipped_open"] == 1  # a1, a2; aktive bleibt
    assert total(env) == 5


def test_prune_needs_fresh_min_age_and_the_shown_count(env):
    stale(env)
    assert env.post(f"{S}/prune", json={"older_than_days": 90, "confirm_count": 2}).status_code == 401
    env.app.state.sessions.get(env.cookies.get(SESSION_COOKIE)).auth_time = env.app.state.sessions.now()
    assert env.post(f"{S}/prune", json={"older_than_days": 0, "confirm_count": 4}).status_code == 422  # 0 Tage träfe alles, auch mit passender Zahl
    assert env.post(f"{S}/prune", json={"older_than_days": 90, "confirm_count": 99}).status_code == 422
    assert total(env) == 5  # nichts gelöscht
    r = env.post(f"{S}/prune", json={"older_than_days": 90, "confirm_count": 2})
    assert r.status_code == 200 and r.json()["removed"] == 2 and total(env) == 3
    assert "GEHEIMER-TITEL" not in env.audit_file.read_text()


def test_bulk_delete_limits_confirms_and_reports_skipped_active(env):
    stale(env)
    assert env.post(f"{S}/bulk-delete", json={"ids": ["a1"], "confirm_count": 1}).status_code == 401
    env.app.state.sessions.get(env.cookies.get(SESSION_COOKIE)).auth_time = env.app.state.sessions.now()
    assert env.post(f"{S}/bulk-delete", json={"ids": [f"s{i}" for i in range(501)], "confirm_count": 501}).status_code == 422
    assert env.post(f"{S}/bulk-delete", json={"ids": ["a1", "a2"], "confirm_count": 1}).status_code == 422
    assert env.post(f"{S}/bulk-delete", json={"ids": ["../x"], "confirm_count": 1}).status_code == 422
    assert env.post(f"{S}/bulk-delete", json={"ids": [], "confirm_count": 0}).status_code == 422
    assert total(env) == 5
    r = env.post(f"{S}/bulk-delete", json={"ids": ["a1", "act"], "confirm_count": 2})
    assert r.status_code == 200 and r.json()["deleted"] == 1 and r.json()["skipped_active"] == ["act"]
    assert total(env) == 4


def test_empty_sessions_count_then_delete_with_typed_count(env):
    stale(env)
    assert env.request("DELETE", f"{S}/empty", params={"confirm": "1"}).status_code == 401
    env.app.state.sessions.get(env.cookies.get(SESSION_COOKIE)).auth_time = env.app.state.sessions.now()
    assert env.get(f"{S}/empty").json()["count"] == 1
    assert env.request("DELETE", f"{S}/empty", params={"confirm": "7"}).status_code == 422
    assert env.request("DELETE", f"{S}/empty").status_code == 422
    assert total(env) == 5
    r = env.request("DELETE", f"{S}/empty", params={"confirm": "1"})
    assert r.status_code == 200 and r.json()["deleted"] == 1 and total(env) == 4


def test_export_returns_one_session_and_404_for_unknown_or_unsafe_ids(env):
    b = env.get(f"{S}/a1/export").json()
    assert b["id"] == "a1" and isinstance(b["messages"], list) and len(b["messages"]) == 3
    assert env.get(f"{S}/gibtsnicht/export").status_code == 404
    assert env.get(f"{S}/..%2Fx/export").status_code in (404, 422)


def test_dropped_deletes_are_not_reported_as_success(tmp_path, make_settings):
    f = tmp_path / "s2.json"
    rt = {"id": "hermes", "base_url": "http://hermes.test", "api_key": "k", "multiplex": True, "agents": ["default"], "dashboard": {"base_url": "http://dash.test"}}
    f.write_text(json.dumps({"hosts": [{"id": "server", "runtimes": [rt]}]}))
    dash = create_dashboard(drop_writes=True)
    settings = make_settings(hosts_file=f, auth_mode="oidc", oidc_issuer="https://id.test", oidc_client_id="t", oidc_client_secret="t", oidc_allowed_sub="user", public_url="http://testserver")
    app = create_app(settings, transport=RouterTransport({"hermes.test": httpx.ASGITransport(app=create_mock(delay=0)), "dash.test": httpx.ASGITransport(app=dash)}))
    with TestClient(app) as c:
        s = app.state.sessions.create(User("user", "Test"))
        s.auth_time = app.state.sessions.now()
        c.cookies.set(SESSION_COOKIE, s.id)
        c.headers.update(HDR)
        dash.state.profiles["default"]["sessions"] = [row("a1", 200), row("a2", 100)]
        assert c.post(f"{S}/prune", json={"older_than_days": 90, "confirm_count": 2}).status_code == 502
        assert c.post(f"{S}/bulk-delete", json={"ids": ["a1"], "confirm_count": 1}).status_code == 502
