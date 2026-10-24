"""Einstellungen eines Hermes-Profils über das Dashboard (GET|PUT /bff/h/{host}/{runtime}/{agent}/config)."""
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import SESSION_COOKIE, User
from app.main import create_app
from devtools.mock_dashboard import create_mock as create_dashboard
from devtools.mock_hermes import create_mock
from tests.conftest import BASE, HDR, RouterTransport

CFG = f"{BASE}/config"


@pytest.fixture
def env(tmp_path, make_settings):
    f = tmp_path / "hosts.json"
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
        yield c


def fields(c, path=CFG):
    return {f["key"]: f for f in c.get(path).json()["fields"]}


def test_read_merges_schema_and_values_and_never_sends_secrets(env):
    body = env.get(CFG).json()
    assert body["category_order"] == ["general", "agent", "display", "tools"]
    f = fields(env)
    assert f["model"]["value"] == "claude-test" and f["agent.max_turns"]["value"] == 90 and f["display.streaming"]["value"] is True
    assert f["agent.service_tier"]["options"] == ["", "normal", "fast"]
    assert f["web.api_key"]["secret"] is True and f["web.api_key"]["value"] is None and f["web.api_key"]["set"] is True
    assert "geheim-aus-der-config" not in env.get(CFG).text


def test_read_is_scoped_to_the_profile_and_unknown_profiles_are_rejected(env):
    assert env.get("/bff/h/server/hermes/gamma/config").status_code == 404


def test_write_changes_only_what_was_sent_and_reads_it_back(env):
    r = env.put(CFG, json={"changes": {"agent.max_turns": 40, "agent.service_tier": "fast", "display.streaming": False}})
    assert r.status_code == 200 and sorted(r.json()["changed"]) == ["agent.max_turns", "agent.service_tier", "display.streaming"]
    assert env.dash.state.profiles["default"]["config"]["custom_providers"] == [{"name": "x"}]  # Schlüssel außerhalb der Änderung bleiben
    f = fields(env)
    assert (f["agent.max_turns"]["value"], f["agent.service_tier"]["value"], f["display.streaming"]["value"]) == (40, "fast", False)
    assert f["model"]["value"] == "claude-test"  # unberührt


def test_write_does_not_leak_into_other_profiles(env):
    env.put(CFG, json={"changes": {"agent.max_turns": 7}})
    assert fields(env, "/bff/h/server/hermes/beta/config")["agent.max_turns"]["value"] == 90


@pytest.mark.parametrize("changes", [
    {"nicht.im.schema": 1},
    {"web.api_key": "neu"},  # Geheimnisse gehören auf die Seite Keys & Nutzung
    {"agent.max_turns": "viel"},
    {"agent.max_turns": True},
    {"agent.service_tier": "turbo"},
    {"display.streaming": "ja"},
    {"model": 5},
    {"fallback_providers": "a"},
    {"agent.max_turns": float("inf")},
    {},
])
def test_invalid_changes_are_rejected_before_anything_is_sent(env, changes):
    r = env.request("PUT", CFG, content=json.dumps({"changes": changes}).replace("Infinity", "1e999"), headers={"content-type": "application/json"})
    assert r.status_code == 422, r.text
    assert fields(env)["agent.max_turns"]["value"] == 90


def test_dashboard_that_drops_the_write_is_reported_not_swallowed(make_settings, tmp_path):
    f = tmp_path / "hosts.json"
    f.write_text(json.dumps({"hosts": [{"id": "server", "runtimes": [{"id": "hermes", "base_url": "http://hermes.test", "api_key": "k", "multiplex": True, "agents": ["default"], "dashboard": {"base_url": "http://dash.test"}}]}]}))
    app = create_app(make_settings(hosts_file=f), transport=RouterTransport({"hermes.test": httpx.ASGITransport(app=create_mock(delay=0)), "dash.test": httpx.ASGITransport(app=create_dashboard(drop_writes=True))}))
    with TestClient(app) as c:
        c.headers.update(HDR)
        r = c.put(CFG, json={"changes": {"agent.max_turns": 3}})
        assert r.status_code == 502 and "agent.max_turns" in r.text


def test_writes_need_a_fresh_login_and_reading_does_not(env):
    env.app.state.sessions.get(env.cookies.get(SESSION_COOKIE)).auth_time = 0
    assert env.get(CFG).status_code == 200
    r = env.put(CFG, json={"changes": {"agent.max_turns": 3}})
    assert r.status_code == 401 and r.json()["detail"]["code"] == "step_up_required"
    assert fields(env)["agent.max_turns"]["value"] == 90


def test_audit_names_the_keys_but_never_the_values(env):
    env.put(CFG, json={"changes": {"model": "geheimes-modell-xyz"}})
    log = env.audit_file.read_text()
    assert "profile.config" in log and "model" in log and "geheimes-modell-xyz" not in log


def test_without_dashboard_the_page_gets_501(make_settings):
    app = create_app(make_settings(), transport=RouterTransport({"hermes.test": httpx.ASGITransport(app=create_mock(delay=0))}))
    with TestClient(app) as c:
        c.headers.update(HDR)
        assert c.get("/bff/h/laptop/hermes/default/config").status_code == 501


@pytest.mark.parametrize("key,kind,secret", [
    ("auxiliary.vision.api_key", "string", True), ("delegation.api_key", "string", True), ("dashboard.basic_auth.password", "string", True),
    ("dashboard.basic_auth.password_hash", "string", True), ("dashboard.basic_auth.secret", "string", True),
    ("compression.proactive_prune_tokens", "number", False),  # Zählwert
    ("security.redact_secrets", "boolean", False),  # Schalter
    ("secrets.bitwarden.enabled", "boolean", False),
    ("secrets.bitwarden.access_token_env", "string", False),  # Name einer Umgebungsvariable, nicht das Token
    ("desktop.password_store", "string", False), ("proxy.credential_source", "select", False),
])
def test_secret_detection_hits_keys_not_counters_or_switches(key, kind, secret):
    from app.routes.hermes_config import is_secret
    assert is_secret(key, kind) is secret
