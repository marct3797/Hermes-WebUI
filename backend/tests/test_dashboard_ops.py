"""Dashboard als lesende Ersatzquelle für Host-Daten, wenn der Host-Dienst Profile nicht sieht (Hermes im Container)."""
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app import dashboard_ops
from app.auth import SESSION_COOKIE, User
from app.main import create_app
from conftest import RouterTransport
from devtools.mock_dashboard import create_mock as create_dashboard
from test_operations import HDR, TOKEN, create_mock as create_hostd


@pytest.fixture
def ops(tmp_path, make_settings, monkeypatch):
    from app.routes.operations import router
    monkeypatch.setenv("TEST_HOSTD", TOKEN)
    hostd = {"base_url": "http://daemon.test", "token_env": "TEST_HOSTD"}
    agent = {"id": "hermes", "base_url": "http://daemon.test", "api_key": TOKEN, "multiplex": True, "agents": ["default", "beta"]}
    f = tmp_path / "hosts.json"
    f.write_text(json.dumps({"hosts": [
        {"id": "ct", "hostd": hostd, "runtimes": [{**agent, "dashboard": {"base_url": "http://dash.test"}}]},
        {"id": "plain", "hostd": hostd, "runtimes": [agent]},
        {"id": "nodaemon", "runtimes": [{**agent, "dashboard": {"base_url": "http://dash.test"}}]},
    ]}))
    daemon = create_hostd()
    transport = RouterTransport({"daemon.test": httpx.ASGITransport(app=daemon), "dash.test": httpx.ASGITransport(app=create_dashboard())})
    settings = make_settings(hosts_file=f, auth_mode="oidc", oidc_issuer="https://id.test", oidc_client_id="test",
                             oidc_client_secret="test", oidc_allowed_sub="user", public_url="http://testserver")
    app = create_app(settings, transport=transport)
    if "/bff/h/{host}/_hostd" not in app.openapi()["paths"]:
        previous = list(app.router.routes)
        app.include_router(router)
        app.router.routes[:] = app.router.routes[len(previous):] + previous
    with TestClient(app) as client:
        session = app.state.sessions.create(User("user", "Test"))
        session.auth_time = app.state.sessions.now()
        client.cookies.set(SESSION_COOKIE, session.id)
        client.headers.update(HDR)
        yield client, daemon


def test_redact_drops_secret_lines_and_url_credentials():
    text = dashboard_ops.redact("ok\nAuthorization: Bearer x\nsiehe https://u:pw@h.test:8/p?token=1#f\n-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----")
    assert text.splitlines()[:2] == ["ok", "[redacted]"]
    assert "siehe https://h.test:8/p" in text and "pw" not in text and "token=1" not in text
    assert "abc" not in text


def test_catalog_uses_dashboard_profiles_when_daemon_is_unusable(ops):
    c, daemon = ops
    daemon.state.fail = 404  # veralteter Host-Dienst
    catalog = c.get("/bff/h/ct/_manage").json()
    assert [p["id"] for p in catalog["profiles"]] == ["default", "beta", "eta"]
    assert catalog["source"] == "dashboard"
    assert c.get("/bff/h/nodaemon/_manage").json()["profiles"]  # gar kein Host-Dienst konfiguriert
    daemon.state.fail = None
    assert c.get("/bff/h/plain/_manage").json()["profiles"] == [{"id": "default"}]  # Host-Dienst wie bisher, kein Umweg


def test_catalog_without_any_source_keeps_the_original_error(ops):
    c, daemon = ops
    daemon.state.fail = 503
    assert c.get("/bff/h/plain/_manage").status_code == 503


def test_kanban_is_read_only_redacted_and_bounded(ops):
    c, daemon = ops
    daemon.state.fail = 404
    data = c.get("/bff/h/ct/_manage/default/kanban").json()
    assert data["available"] and data["actions"] == [] and data["columns"] == ["todo", "done"]
    todo = [t for t in data["tasks"] if t["status"] == "todo"]
    assert "hunter2" not in json.dumps(data) and "Sonst harmlos" in todo[0]["description"]
    done = [t for t in data["tasks"] if t["status"] == "done"]
    assert len(done) == dashboard_ops.TASKS_PER_COLUMN and done[0]["id"] == "t_61"  # neueste zuerst
    assert data["truncated"] is True and all(isinstance(t["title"], str) for t in data["tasks"])
    assert c.get("/bff/h/ct/_manage/ghost/kanban").status_code == 404
    assert c.post("/bff/h/ct/_manage/default/kanban/transition", json={"id": "t_1"}).status_code == 404


def test_logs_are_redacted_and_marked(ops):
    c, daemon = ops
    daemon.state.fail = 404
    data = c.get("/bff/h/ct/_manage/default/logs").json()
    assert data["redacted"] is True and data["content"].splitlines()[0] == "start ok"
    assert "Bearer" not in data["content"] and "pw@" not in data["content"] and "token=1" not in data["content"]


def test_mcp_never_leaks_env_args_or_url(ops):
    c, daemon = ops
    daemon.state.fail = 404
    data = c.get("/bff/h/ct/_manage/default/mcp").json()
    assert data["items"] == [{"id": "rag", "name": "rag", "description": "Übertragung: stdio", "enabled": True}]
    assert "geheim" not in json.dumps(data)


def test_plugins_and_skills_map_without_paths(ops):
    c, daemon = ops
    daemon.state.fail = 404
    plugins = c.get("/bff/h/ct/_manage/default/plugins").json()
    assert plugins["items"][0]["status"] == "enabled" and "geheim" not in json.dumps(plugins)
    skills = c.get("/bff/h/ct/_manage/default/skills").json()
    assert [s["name"] for s in skills["items"]] == ["plan", "mein-skill"] and skills["actions"] == []


def test_working_daemon_answer_is_not_replaced(ops):
    c, daemon = ops
    assert c.get("/bff/h/ct/_manage/default/skills").json()["items"] == []  # Antwort des Host-Dienstes bleibt maßgeblich
    assert "source" not in c.get("/bff/h/ct/_manage/default/skills").json()


def test_daemon_reporting_unavailable_falls_back_but_a_host_without_dashboard_keeps_it(ops):
    c, daemon = ops
    daemon.state.unavailable = True
    data = c.get("/bff/h/ct/_manage/default/kanban").json()
    assert data["source"] == "dashboard" and data["tasks"]
    plain = c.get("/bff/h/plain/_manage/default/kanban").json()
    assert plain["available"] is False and "source" not in plain
    daemon.state.unavailable = False
    daemon.state.fail = 404
    assert c.get("/bff/h/plain/_manage/default/kanban").status_code == 404


def test_search_falls_back_to_dashboard_when_daemon_fails_or_finds_nothing(ops):
    c, daemon = ops
    daemon.state.fail = 404
    found = c.get("/bff/search", params={"q": "forgejo"}).json()
    hits = [r for r in found["results"] if r["host"] == "ct"]
    assert hits and hits[0]["profile"] == "beta" and hits[0]["title"] == "" and "forgejo" in hits[0]["snippet"]
    assert any(w["host"] == "plain" for w in found["warnings"])  # ohne Ersatzquelle bleibt der Fehler sichtbar


def test_git_conflict_from_an_old_daemon_is_shown_as_no_repository(ops):
    c, daemon = ops
    assert c.get("/bff/h/plain/_git", params={"workspace": "repo"}).json()["branch"] == "main"
    daemon.state.fail = 409
    assert c.get("/bff/h/plain/_git", params={"workspace": "repo"}).json()["repository"] is False
    daemon.state.fail = 503
    assert c.get("/bff/h/plain/_git", params={"workspace": "repo"}).status_code == 503


def test_step_up_can_be_switched_off(ops):
    c, _daemon = ops
    sessions = c.app.state.sessions
    sessions.get(c.cookies.get(SESSION_COOKIE)).auth_time = 0  # Anmeldung lange her
    body = {"cli": "codex", "workspace": "repo"}
    assert c.post("/bff/h/plain/_terminals", json=body).status_code == 401
    assert c.get("/bff/me").json()["fresh"] is False
    c.app.state.settings.step_up = False
    assert c.post("/bff/h/plain/_terminals", json=body).status_code == 200
    assert c.get("/bff/me").json()["fresh"] is True
