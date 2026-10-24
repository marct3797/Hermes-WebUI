"""Eingebautes Hermes-Gedächtnis (MEMORY.md/USER.md) und externe Gedächtnis-Anbieter eines Profils.

Das Dashboard liefert vom eingebauten Gedächtnis nur die Dateigrößen, nie den Inhalt; die WebUI zeigt, was es zeigt. Der Anbieter-Setup von Hermes
führt Installationsbefehle aus (`curl ... | sh`) und wird nicht angeboten. Zurücksetzen löscht endgültig und braucht die Eingabe des Zielnamens.
"""
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import SESSION_COOKIE, User
from app.main import create_app
from devtools.mock_dashboard import create_mock as create_dashboard
from devtools.mock_hermes import create_mock
from tests.conftest import BASE, HDR, RouterTransport

H = f"{BASE}/hermes-memory"
KEY = "rdb-sehr-geheimer-key-4711"


def logged_in(tmp_path, make_settings, dash):
    f = tmp_path / "hosts.json"
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


def providers(c, path=H):
    return {p["name"]: p for p in c.get(path).json()["providers"]}


def test_overview_shows_builtin_sizes_and_providers_with_what_is_missing(env):
    body = env.get(H).json()
    assert body["active"] == "" and body["files"] == {"memory": 120, "user": 45}
    p = providers(env)
    assert p["retaindb"]["status"] == "needs_config" and p["retaindb"]["required_env"] == ["RETAINDB_API_KEY"]
    assert p["byterover"]["status"] == "unavailable" and p["byterover"]["missing"] == [{"name": "brv", "install": "curl -fsSL https://byterover.dev/install.sh | sh"}]
    assert "content" not in json.dumps(body) and "check" not in json.dumps(p["byterover"])


def test_overview_is_scoped_to_the_profile(env):
    env.dash.state.profiles["beta"]["memory"] = {"active": "", "files": {"memory": 7, "user": 0}, "cfg": {}, "installed": set()}
    assert env.get("/bff/h/server/hermes/beta/hermes-memory").json()["files"] == {"memory": 7, "user": 0}
    assert env.get("/bff/h/server/hermes/gamma/hermes-memory").status_code == 404


def test_provider_fields_never_carry_a_secret_value(env):
    env.dash.state.profiles["default"]["env"]["RETAINDB_API_KEY"] = KEY
    r = env.get(f"{H}/providers/retaindb")
    f = {x["key"]: x for x in r.json()["fields"]}
    assert KEY not in r.text and f["api_key"]["kind"] == "secret" and f["api_key"]["is_set"] is True and "value" not in f["api_key"]
    assert f["mode"]["value"] == "fast" and [o["value"] for o in f["mode"]["options"]] == ["fast", "deep"]


def test_configuring_a_provider_stores_the_key_and_activates_it_once_it_is_ready(env):
    r = env.put(f"{H}/providers/retaindb", json={"values": {"api_key": KEY, "project": "demo", "mode": "deep"}})
    assert r.status_code == 200 and r.json() == {"ok": True, "active": "retaindb"} and KEY not in r.text
    assert env.dash.state.profiles["default"]["env"]["RETAINDB_API_KEY"] == KEY
    assert env.get(H).json()["active"] == "retaindb" and providers(env)["retaindb"]["status"] == "ready"
    assert KEY not in env.get(f"{H}/providers/retaindb").text


@pytest.mark.parametrize("values", [{"gibtsnicht": "x"}, {"api_key": "«redacted:abcd...wxyz»"}, {"api_key": "a\nb"}, {"api_key": "x" * 5000},
                                    {"mode": "unbekannt"}, {"project": ["liste"]}, {"project": 5}])
def test_unknown_fields_and_malformed_values_are_refused_before_anything_is_written(env, values):
    assert env.put(f"{H}/providers/retaindb", json={"values": values}).status_code == 422
    assert "RETAINDB_API_KEY" not in env.dash.state.profiles["default"]["env"] and env.get(H).json()["active"] == ""


def test_a_provider_that_stays_unready_is_not_activated_and_the_reason_is_shown(env):
    r = env.put(f"{H}/providers/byterover", json={"values": {"auto_extract": "true"}})
    assert r.status_code == 502 and "not ready" in r.text and env.get(H).json()["active"] == ""


def test_error_texts_never_echo_what_was_submitted(env):
    r = env.put(f"{H}/providers/retaindb", json={"values": {"project": "echo:geheim-xyz"}})
    assert r.status_code == 502 and "geheim-xyz" not in r.text


def test_switching_the_active_provider_needs_a_ready_one_and_empty_means_builtin(env):
    env.put(f"{H}/providers/retaindb", json={"values": {"api_key": KEY}})
    assert env.put(f"{H}/provider", json={"provider": ""}).json() == {"ok": True, "active": ""} and env.get(H).json()["active"] == ""
    assert env.put(f"{H}/provider", json={"provider": "retaindb"}).status_code == 200 and env.get(H).json()["active"] == "retaindb"
    assert env.put(f"{H}/provider", json={"provider": "byterover"}).status_code == 422
    assert env.put(f"{H}/provider", json={"provider": "erfunden"}).status_code == 422
    assert env.get(H).json()["active"] == "retaindb"


def test_a_dashboard_that_drops_the_switch_is_reported(tmp_path, make_settings):
    for c in logged_in(tmp_path, make_settings, create_dashboard(drop_writes=True)):
        c.dash.state.profiles["default"]["env"]["RETAINDB_API_KEY"] = KEY
        r = c.put(f"{H}/provider", json={"provider": "retaindb"})
        assert r.status_code == 502 and "nicht übernommen" in r.text


def test_reset_needs_the_name_of_what_is_deleted_typed_out(env):
    for body in ({"target": "all"}, {"target": "all", "confirm": "memory"}, {"target": "memory", "confirm": "alles"}, {"target": "gibtsnicht", "confirm": "gibtsnicht"}):
        assert env.post(f"{H}/reset", json=body).status_code == 422, body
    assert env.dash.state.memory_calls == [] and env.get(H).json()["files"] == {"memory": 120, "user": 45}


def test_reset_deletes_only_the_chosen_file_and_says_what_went(env):
    r = env.post(f"{H}/reset", json={"target": "user", "confirm": "user"})
    assert r.status_code == 200 and r.json() == {"ok": True, "deleted": ["USER.md"]}
    assert env.get(H).json()["files"] == {"memory": 120, "user": 0}
    assert env.post(f"{H}/reset", json={"target": "all", "confirm": "all"}).json()["deleted"] == ["MEMORY.md"]
    assert env.get("/bff/h/server/hermes/beta/hermes-memory").json()["files"] == {"memory": 120, "user": 45}


def test_a_reset_that_did_not_happen_is_reported(tmp_path, make_settings):
    for c in logged_in(tmp_path, make_settings, create_dashboard(drop_writes=True)):
        r = c.post(f"{H}/reset", json={"target": "all", "confirm": "all"})
        assert r.status_code == 502 and "nicht übernommen" in r.text


def test_the_install_step_of_hermes_is_not_reachable(env):
    for method, path in [("POST", f"{H}/providers/byterover/setup"), ("PUT", f"{H}/providers/byterover/setup"), ("POST", f"{BASE}/memory/providers/byterover/setup")]:
        assert env.request(method, path, json={}).status_code in (404, 405)
    assert env.dash.state.memory_calls == []


def test_changes_need_a_fresh_login_and_reading_does_not(env):
    env.app.state.sessions.get(env.cookies.get(SESSION_COOKIE)).auth_time = 0
    assert env.get(H).status_code == 200 and env.get(f"{H}/providers/retaindb").status_code == 200
    for method, path, body in [("PUT", f"{H}/provider", {"provider": ""}), ("POST", f"{H}/reset", {"target": "all", "confirm": "all"}), ("PUT", f"{H}/providers/retaindb", {"values": {"project": "x"}})]:
        r = env.request(method, path, json=body)
        assert r.status_code == 401 and r.json()["detail"]["code"] == "step_up_required", path
    assert env.dash.state.memory_calls == [] and env.get(H).json()["files"] == {"memory": 120, "user": 45}


def test_audit_names_what_was_done_never_values(env):
    env.put(f"{H}/providers/retaindb", json={"values": {"api_key": KEY, "project": "mein-projekt-xyz"}})
    env.post(f"{H}/reset", json={"target": "user", "confirm": "user"})
    log = env.audit_file.read_text()
    assert "hermes_memory.config" in log and "retaindb" in log and "api_key" in log and "hermes_memory.reset" in log and KEY not in log and "mein-projekt-xyz" not in log


def test_writes_are_rate_limited(env):
    env.app.state.limiter.per_minute = 3
    assert 429 in [env.put(f"{H}/provider", json={"provider": ""}).status_code for _ in range(6)]


def test_without_a_dashboard_the_page_gets_501(make_settings):
    app = create_app(make_settings(), transport=RouterTransport({"hermes.test": httpx.ASGITransport(app=create_mock(delay=0))}))
    with TestClient(app) as c:
        c.headers.update(HDR)
        assert c.get("/bff/h/laptop/hermes/default/hermes-memory").status_code == 501
