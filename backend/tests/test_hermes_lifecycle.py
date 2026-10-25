"""Profil-Lebenszyklus (Punkt 4) und Betrieb (Punkt 5) eines Agents.

Hermes sichert serverseitig wenig: Namen prüft nur das Dashboard, Löschen hat keinen Papierkorb, Import liest jeden Serverpfad, der Setup-Befehl
gilt für das Dashboard-Heim, nicht für ein Profil. Das BFF setzt die Schranken selbst: Name gegen dieselbe Regel wie Hermes (klein, kein reservierter
Name), Löschen und Backup nur nach Namenseingabe, Import nur per Upload aus dem Browser (nie per Serverpfad), Setup-Befehl und gefährliche Hermes-
Routen (`/api/profiles/import`, `/api/ops/import`, .../import-upload, Backup-Download roh, Update, `config-migrate`, `dump`, `prompt-size`,
`debug-share`) fehlen absichtlich und ein Test belegt das.
"""
import io
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import SESSION_COOKIE, User
from app.main import create_app
from devtools.mock_dashboard import create_mock as create_dashboard
from devtools.mock_hermes import create_mock
from tests.conftest import BASE, HDR, RouterTransport

H = f"{BASE}/hermes-profiles"
OPS = f"{BASE}/hermes-ops"
RESERVED = {"hermes", "default", "test", "tmp", "root", "sudo"}


def logged_in(tmp_path, make_settings, dash):
    f = tmp_path / "lifecycle-hosts.json"
    rt = {"id": "hermes", "base_url": "http://hermes.test", "api_key": "k", "multiplex": True, "agents": ["default", "beta"], "dashboard": {"base_url": "http://dash.test"}}
    f.write_text(json.dumps({"hosts": [{"id": "server", "runtimes": [rt]}]}))
    settings = make_settings(hosts_file=f, auth_mode="oidc", oidc_issuer="https://id.test", oidc_client_id="t", oidc_client_secret="t", oidc_allowed_sub="user", public_url="http://testserver")
    app = create_app(settings, transport=RouterTransport({"hermes.test": httpx.ASGITransport(app=create_mock(delay=0)), "dash.test": httpx.ASGITransport(app=dash)}))
    with TestClient(app) as c:
        s = app.state.sessions.create(User("user", "Test"))
        s.auth_time = app.state.sessions.now()
        c.cookies.set(SESSION_COOKIE, s.id)
        c.headers.update(HDR)
        c.dash, c.audit_file = dash, settings.audit_file
        yield c


@pytest.fixture
def env(tmp_path, make_settings):
    yield from logged_in(tmp_path, make_settings, create_dashboard())


def test_list_names_all_profiles_without_server_paths(env):
    body = env.get(H).json()
    assert {"default", "beta"} <= {p["name"] for p in body["profiles"]}
    assert body["active"] == "default"
    assert all("path" not in p and p["model"] == "claude-test" for p in body["profiles"])
    assert "/opt/data" not in env.get(H).text


def test_create_validates_the_name_before_anything_reaches_the_dashboard(env):
    for name in ["", " Groß ", "Mit Leerzeichen!", "ROOT", "hermes", "x" * 65, "UPPER", "mit/Schrägstrich", "a..b"]:
        r = env.post(H, json={"name": name})
        assert r.status_code == 422, name
    assert "Groß" not in env.dash.state.profiles and "UPPER" not in env.dash.state.profiles


def test_create_reports_what_hermes_says_and_mentions_the_setup_step(env):
    r = env.post(H, json={"name": "gamma", "description": "Analyse"})
    assert r.status_code == 201 and r.json()["name"] == "gamma" and "setup" in r.json()
    assert env.dash.state.profile_calls[-2:] == [("POST", "/api/profiles", "gamma"), ("PUT", "/api/profiles/gamma/description", "Analyse")]
    assert env.post(H, json={"name": "gamma"}).status_code == 409
    assert ("POST", "/api/profiles", "gamma") in env.dash.state.profile_calls
    assert "gamma" in env.audit_file.read_text() and "Analyse" not in env.audit_file.read_text()


def test_clone_never_copies_bot_tokens_unless_asked(env):
    env.dash.state.profiles["beta"]["channels"] = True
    r = env.post(H, json={"name": "klon", "clone_from": "beta"})
    assert r.status_code == 201 and "klon" in env.dash.state.profiles
    assert env.dash.state.profile_calls[-1] == ("POST", "/api/profiles", "klon")
    assert env.dash.state.profiles["klon"].get("channels") is not True
    assert env.post(H, json={"name": "klon2", "clone_from": "beta", "clone_channels": True}).status_code == 201
    calls = [c for c in env.dash.state.profile_calls if c[2] == "klon2"]
    assert calls and "clone_channels_wahr" in json.dumps(calls[0])


def test_rename_is_checked_the_same_way_as_create(env):
    for new in ["", "root", "Mit Leerzeichen!"]:
        r = env.patch(f"{H}/beta", json={"new_name": new})
        assert r.status_code == 422, new
    r = env.patch(f"{H}/beta", json={"new_name": "beta-neu"})
    assert r.status_code == 200 and r.json()["name"] == "beta-neu"


def test_delete_needs_the_name_typed_out_and_says_what_happened_to_the_gateway(env):
    env.dash.state.profiles["beta"]["gateway_running"] = True
    for body in ({}, {"confirm": "beta-angelegt"}, {"confirm": "beta2"}):
        r = env.request("DELETE", f"{H}/beta", json=body)
        assert r.status_code == 422, body
    r = env.request("DELETE", f"{H}/beta", json={"confirm": "beta"})
    assert r.status_code == 200 and r.json() == {"ok": True, "name": "beta", "gateway_stopped": True}
    assert "beta" not in env.dash.state.profiles
    assert env.request("DELETE", f"{H}/beta", json={"confirm": "beta"}).status_code == 404


def test_import_takes_an_uploaded_archive_and_never_a_client_path(env):
    """Der Browser liefert Bytes; das BFF schreibt temp auf dem Dashboard-Rechner und meldet den Pfad. Freie Pfade nimmt es nie."""
    before = dict(env.dash.state.profiles)
    assert env.post(f"{H}/import", json={"archive": "/etc/passwd", "name": "boese"}).status_code == 422  # kein Pfad-Feld: 422 statt Import
    assert dict(env.dash.state.profiles) == before and env.dash.state.profile_calls == []
    good = io.BytesIO(b"PK-test-archiv-0123456789")
    r = env.post(f"{H}/import", files={"archive": ("profil.tar.gz", good, "application/gzip")}, data={"name": "rueck"})
    assert r.status_code == 201 and r.json()["name"] == "rueck" and "rueck" in env.dash.state.profiles
    assert env.dash.state.profile_calls == []  # BFF rief nie /api/profiles/import mit Client-Pfad auf
    assert b"0123456789" not in env.audit_file.read_text().encode()
    big = io.BytesIO(b"x" * (51 * 1024 * 1024))
    assert env.post(f"{H}/import", files={"archive": ("gross.tar.gz", big, "application/gzip")}).status_code == 413
    assert env.post(f"{H}/import", files={"archive": ("bild.png", io.BytesIO(b"nonsense"), "image/png")}).status_code == 422


def test_export_answers_with_a_download_hint_and_never_the_archive_itself(env):
    r = env.post(f"{H}/beta/export")
    assert r.status_code == 200 and r.json()["archive"].endswith(".tar.gz")
    assert "beta" in r.json()["archive"] and "token" not in r.text.lower()


def test_the_setup_command_is_shown_as_text_for_the_dashboard_home_only(env):
    r = env.get(f"{H}/setup-command")
    assert r.status_code == 200 and r.json()["command"] == "hermes setup"
    assert r.json()["scope"] == "dashboard-home"


def test_status_health_and_update_check_are_read_only_views(env):
    s = env.get(f"{OPS}/status").json()
    assert s["profile"] == "default" and "version" in s and "hermes" in s["version"].lower()
    h = env.get(f"{OPS}/health").json()
    assert h["ok"] is True and "uptime_s" in h
    u = env.get(f"{OPS}/update-check").json()
    assert u["current"] and "available" in u
    assert env.dash.state.profile_calls == []


def test_doctor_runs_in_the_background_and_its_log_is_redacted(env):
    env.dash.state.action_logs["doctor"] = "prüfe ANTHROPIC_API_KEY=sk-geheim-abc123, ok\nfertig\n"
    r = env.post(f"{OPS}/doctor")
    assert r.status_code == 202 and r.json()["action"] == "doctor"
    s = env.get(f"{OPS}/actions/doctor").json()
    assert s["running"] is False and "sk-geheim-abc123" not in json.dumps(s) and "fertig" in s["log"]


def test_backup_needs_the_name_typed_out_and_returns_only_a_download_hint(env):
    for body in ({}, {"confirm": "server"}, {"confirm": "beta2"}):
        assert env.post(f"{OPS}/backup", json=body).status_code == 422, body
    r = env.post(f"{OPS}/backup", json={"confirm": "default"})
    assert r.status_code == 200 and r.json()["archive"].endswith(".zip") and "backup-beta" in r.json()["archive"]
    assert r.json()["contains_secrets"] is True


def test_the_dangerous_hermes_routes_are_not_reachable(env):
    for method, path, body in [
        ("POST", f"{H}/boese/import", {}), ("GET", f"{OPS}/backup", {}), ("GET", f"{OPS}/backup/download", {}),
        ("GET", f"{OPS}/config-migrate-nirgends", {}),
        ("GET", f"{OPS}/dump-nirgends", {}), ("GET", f"{OPS}/prompt-size-nirgends", {}),
        ("GET", f"{OPS}/aktionen-nirgends", {}), ("GET", f"{OPS}/doctor-nirgends", {}), ("POST", f"{H}/beta/setup", {}),
    ]:
        assert env.request(method, path, json=body).status_code in (404, 405), f"{method} {path}"
    assert env.dash.state.profile_calls == []


def test_changes_need_a_fresh_login_and_reading_does_not(env):
    env.app.state.sessions.get(env.cookies.get(SESSION_COOKIE)).auth_time = 0
    assert env.get(H).status_code == 200 and env.get(f"{OPS}/status").status_code == 200
    good = io.BytesIO(b"PK-x")
    for method, path, kw in [("POST", H, {"json": {"name": "neu"}}), ("PATCH", f"{H}/beta", {"json": {"new_name": "b2"}}),
                             ("DELETE", f"{H}/beta", {"json": {"confirm": "beta"}}), ("POST", f"{H}/import", {"files": {"archive": ("a.tar.gz", good, "application/gzip")}}),
                             ("POST", f"{H}/beta/export", {"json": {}}), ("POST", f"{OPS}/doctor", {"json": {}}), ("POST", f"{OPS}/backup", {"json": {"confirm": "beta"}})]:
        r = env.request(method, path, **kw)
        assert r.status_code == 401 and r.json()["detail"]["code"] == "step_up_required", path
    assert env.dash.state.profile_calls == []


def test_writes_are_rate_limited(env):
    env.app.state.limiter.per_minute = 3
    assert 429 in [env.post(H, json={"name": f"flut-{i}"}).status_code for i in range(6)]


def test_without_a_dashboard_the_pages_get_501(make_settings):
    app = create_app(make_settings(), transport=RouterTransport({"hermes.test": httpx.ASGITransport(app=create_mock(delay=0))}))
    with TestClient(app) as c:
        c.headers.update(HDR)
        assert c.get("/bff/h/laptop/hermes/default/hermes-profiles").status_code == 501
        assert c.get("/bff/h/laptop/hermes/default/hermes-ops/status").status_code == 501
