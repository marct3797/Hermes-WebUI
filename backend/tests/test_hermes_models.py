"""Modelle (Punkt 8a): Hauptmodell, Auswahl, Empfehlung, Hilfsmodelle, MoA — lesend frei, schreibend mit Schranken.

Das Dashboard schreibt sofort in config.yaml und gilt nur für neue Sitzungen. Das BFF setzt die Schranken selbst: leere/Provider-freie
Antworten werden zu 502 (kein stilles „kein Modell"), teure Modelle brauchen `confirm_expensive_model`, MoA braucht benannte Presets mit
Referenzmodellen, die Empfehlung prüft gegen die Auswahl (kein Hinzufügen erfundener Modelle).
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

H = f"{BASE}/hermes-models"


@pytest.fixture
def env(tmp_path, make_settings):
    f = tmp_path / "models-hosts.json"
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


def test_info_lists_model_and_provider_and_context(env):
    body = env.get(f"{H}/info").json()
    assert body["provider"] and body["model"], body
    assert isinstance(body.get("context_window"), int)
    assert "capabilities" in body


def test_options_and_recommended_default_report_current_without_inventing(env):
    opts = env.get(f"{H}/options").json()
    rec = env.get(f"{H}/recommended-default").json()
    assert opts["providers"] and rec["provider"] and rec["model"]
    known = {m for p in opts["providers"] for m in p.get("models", [])} | {opts["current"]["model"]}
    assert rec["model"] in known


def test_auxiliary_lists_tasks_with_main_model(env):
    body = env.get(f"{H}/auxiliary").json()
    assert body["main"]["model"] and isinstance(body["tasks"], list) and body["tasks"]


def test_moa_read_shows_presets_and_active(env):
    body = env.get(f"{H}/moa").json()
    assert body["presets"] and body["active_preset"] in body["presets"]


def test_set_main_needs_fresh_login_and_confirm_then_reads_back(env):
    from app.auth import SESSION_COOKIE
    env.app.state.sessions.get(env.cookies.get(SESSION_COOKIE)).auth_time = 0
    r = env.post(f"{H}/set", json={"scope": "main", "provider": "anthropic", "model": "claude-teuer"})
    assert r.status_code == 401 and r.json()["detail"]["code"] == "step_up_required"
    env.app.state.sessions.get(env.cookies.get(SESSION_COOKIE)).auth_time = env.app.state.sessions.now()
    r = env.post(f"{H}/set", json={"scope": "main", "provider": "anthropic", "model": "claude-teuer"})
    assert r.status_code == 200 and r.json().get("confirm_required") is True  # teuer: erst bestätigen
    r = env.post(f"{H}/set", json={"scope": "main", "provider": "anthropic", "model": "claude-teuer", "confirm_expensive_model": True})
    assert r.status_code == 200 and r.json()["model"] == "claude-teuer" and "api_key" not in r.text
    assert env.get(f"{H}/info").json()["model"] == "claude-teuer"  # Rücklesen: Übernahme belegt
    assert "api_key" not in env.audit_file.read_text()


def test_set_rejects_unknown_scope_and_empty_model(env):
    assert env.post(f"{H}/set", json={"scope": "falsch", "provider": "a", "model": "m"}).status_code == 422
    assert env.post(f"{H}/set", json={"scope": "main", "provider": "a", "model": " "}).status_code == 422


def test_moa_write_needs_presets_and_reads_back(env):
    assert env.put(f"{H}/moa", json={"presets": {}}).status_code == 422
    good = {"default_preset": "d", "active_preset": "d", "presets": {"d": {"reference_models": [{"provider": "a", "model": "m"}], "aggregator": {"provider": "a", "model": "m"}}}}
    r = env.put(f"{H}/moa", json=good)
    assert r.status_code == 200
    assert env.get(f"{H}/moa").json()["active_preset"] == "d"


def fresh_install(env):
    p = env.dash.state.profiles["default"]
    p["provider"], p["model"], p["no_providers"] = "", "", True


def test_fresh_install_without_model_is_data_not_an_error(env):
    fresh_install(env)  # echtes Dashboard 0.22.5 ohne Anbieter: gültige, aber leere Antworten
    info = env.get(f"{H}/info")
    assert info.status_code == 200 and info.json()["configured"] is False and info.json()["model"] == ""
    assert env.get(f"{H}/options").json()["providers"] == []
    rec = env.get(f"{H}/recommended-default")
    assert rec.status_code == 200 and rec.json()["available"] is False
    aux = env.get(f"{H}/auxiliary")
    assert aux.status_code == 200 and aux.json()["main"]["model"] == "" and aux.json()["tasks"]


def test_configured_install_reports_configured(env):
    assert env.get(f"{H}/info").json()["configured"] is True
    assert env.get(f"{H}/recommended-default").json()["available"] is True


def test_wrong_shape_is_still_a_502(env):
    env.dash.state.profiles["default"]["malformed"] = True
    assert env.get(f"{H}/info").status_code == 502
    assert env.get(f"{H}/options").status_code == 502
    assert env.get(f"{H}/recommended-default").status_code == 502
    assert env.get(f"{H}/auxiliary").status_code == 502


def test_set_on_a_fresh_install_reads_back(env):
    fresh_install(env)
    r = env.post(f"{H}/set", json={"scope": "main", "provider": "anthropic", "model": "claude-test"})
    assert r.status_code == 200 and env.get(f"{H}/info").json()["configured"] is True
