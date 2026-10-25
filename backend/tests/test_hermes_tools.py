"""Werkzeuge eines Hermes-Profils: ein- und ausschalten, Anbieter und Modell wählen, Werkzeug-Keys setzen,
Terminal-Backend umstellen, Nachinstallation starten, Computer-Use-Stand lesen und anfordern.

Bewusst NICHT durchgereicht: freies `PUT /api/env`, `POST /api/env/reveal`. Das Mock-Dashboard führt diese Routen aus
und merkt sie sich; die Tests belegen, dass sie nie ankommen.
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

T = f"{BASE}/tools"
SECRET = "fc-sehr-geheimer-wert-123"


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


def names(c, path=T):
    return {t["name"]: t for t in c.get(path).json()["toolsets"]}


def test_list_shows_state_per_toolset_and_whether_keys_are_missing(env):
    sets = names(env)
    assert sets["terminal"]["enabled"] is True and sets["terminal"]["configured"] is True
    assert sets["web"]["enabled"] is False and sets["web"]["configured"] is False
    assert sets["web"]["tools"] == ["web_search"]


def test_list_is_scoped_to_the_profile(env):
    env.put(f"{T}/web", json={"enabled": True})
    assert names(env)["web"]["enabled"] is True
    assert names(env, "/bff/h/server/hermes/beta/tools")["web"]["enabled"] is False
    assert env.get("/bff/h/server/hermes/gamma/tools").status_code == 404


def test_config_lists_providers_with_key_state_but_no_values(env):
    env.dash.state.profiles["default"]["env"]["BRAVE_SEARCH_API_KEY"] = SECRET
    body = env.get(f"{T}/web").json()
    brave = next(p for p in body["providers"] if p["name"].startswith("Brave"))
    assert brave["env_vars"] == [{"key": "BRAVE_SEARCH_API_KEY", "prompt": "Brave Search API key", "url": "https://brave.com/search/api/", "is_set": True}]
    assert brave["capabilities"] == ["search"]
    firecrawl = next(p for p in body["providers"] if p["name"].startswith("Firecrawl"))
    assert firecrawl["env_vars"][0]["is_set"] is False
    assert SECRET not in env.get(f"{T}/web").text


def test_config_of_a_toolset_without_choices_is_empty_not_an_error(env):
    assert env.get(f"{T}/terminal").json()["providers"] == []


@pytest.mark.parametrize("name", ["../x", "Web", "web;rm", "a" * 60, "web%2F..%2Fenv"])
def test_toolset_names_are_validated_before_they_reach_the_dashboard(env, name):
    assert env.get(f"{T}/{name}").status_code in (404, 422)
    assert [c for c in env.dash.state.tool_calls] == []


def test_toggle_switches_a_toolset_and_reads_it_back(env):
    r = env.put(f"{T}/web", json={"enabled": True})
    assert r.status_code == 200 and r.json() == {"ok": True, "name": "web", "enabled": True, "post_setup_started": None}
    assert names(env)["web"]["enabled"] is True
    env.put(f"{T}/web", json={"enabled": False})
    assert names(env)["web"]["enabled"] is False


def test_toggle_unknown_toolset_is_rejected(env):
    assert env.put(f"{T}/gibtsnicht", json={"enabled": True}).status_code == 404
    assert env.get(f"{T}/gibtsnicht").status_code == 404
    assert [c for c in env.dash.state.tool_calls if c[0] != "GET"] == []


def test_enabling_a_toolset_that_installs_software_needs_explicit_consent(env):
    """Hermes startet beim Einschalten `tools post-setup` (lädt Programme). Ohne ausdrückliche Zustimmung kommt der Aufruf nicht durch."""
    r = env.put(f"{T}/computer_use", json={"enabled": True})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "install_consent_required"
    assert env.dash.state.post_setups == [] and names(env)["computer_use"]["enabled"] is False
    ok = env.put(f"{T}/computer_use", json={"enabled": True, "accept_install": True})
    assert ok.status_code == 200 and ok.json()["post_setup_started"] == "cua_driver"
    assert env.dash.state.post_setups == [("default", "cua_driver")]


def test_no_consent_is_needed_when_nothing_would_be_installed(env):
    """Meldet das Dashboard den Anbieter als bereit (Programm schon da), startet Hermes nichts: die Zustimmung entfällt."""
    env.dash.state.installed.add("cua_driver")
    r = env.put(f"{T}/computer_use", json={"enabled": True})
    assert r.status_code == 200 and r.json()["post_setup_started"] is None and env.dash.state.post_setups == []


def test_disabling_never_needs_consent(env):
    env.put(f"{T}/computer_use", json={"enabled": True, "accept_install": True})
    assert env.put(f"{T}/computer_use", json={"enabled": False}).status_code == 200


def test_provider_choice_is_saved_and_unknown_providers_rejected(env):
    assert env.put(f"{T}/web/provider", json={"provider": "Firecrawl Cloud", "capability": "extract"}).json()["provider"] == "Firecrawl Cloud"
    assert env.get(f"{T}/web").json()["active_provider"] == "Firecrawl Cloud"
    assert env.put(f"{T}/web/provider", json={"provider": "Erfunden"}).status_code == 422
    assert env.put(f"{T}/image_gen/provider", json={"provider": "FAL.ai", "capability": "search"}).status_code in (400, 422)
    assert env.put(f"{T}/web/provider", json={"provider": "Firecrawl Cloud", "capability": "alles"}).status_code == 422


def test_keys_are_written_only_for_variables_the_toolset_declares(env):
    r = env.put(f"{T}/web/env", json={"env": {"BRAVE_SEARCH_API_KEY": SECRET}})
    assert r.status_code == 200 and r.json()["saved"] == ["BRAVE_SEARCH_API_KEY"] and SECRET not in r.text
    assert env.dash.state.profiles["default"]["env"]["BRAVE_SEARCH_API_KEY"] == SECRET
    assert names(env)["web"]["configured"] is True
    assert SECRET not in env.get(f"{T}/web").text


@pytest.mark.parametrize("key", ["PATH", "ANTHROPIC_API_KEY", "TERMINAL_SSH_HOST", "HERMES_HOME", "brave", "A B"])
def test_other_variables_cannot_be_written_through_a_toolset(env, key):
    r = env.put(f"{T}/web/env", json={"env": {key: "x"}})
    assert r.status_code in (400, 422)
    assert key not in env.dash.state.profiles["default"]["env"] or key == "ANTHROPIC_API_KEY"
    assert env.dash.state.profiles["default"]["env"]["ANTHROPIC_API_KEY"] == "sk-ant-geheim-1234"


@pytest.mark.parametrize("value", ["«redacted:abcd...wxyz»", "***", "abcd...wxyz", "zwei\nzeilen", "x" * 5000])
def test_redacted_previews_and_malformed_values_are_not_saved(env, value):
    assert env.put(f"{T}/web/env", json={"env": {"BRAVE_SEARCH_API_KEY": value}}).status_code == 422
    assert "BRAVE_SEARCH_API_KEY" not in env.dash.state.profiles["default"]["env"]


def test_an_empty_value_does_not_delete_a_key(env):
    env.put(f"{T}/web/env", json={"env": {"BRAVE_SEARCH_API_KEY": SECRET}})
    r = env.put(f"{T}/web/env", json={"env": {"BRAVE_SEARCH_API_KEY": "  "}})
    assert r.status_code == 200 and r.json()["skipped"] == ["BRAVE_SEARCH_API_KEY"]
    assert env.dash.state.profiles["default"]["env"]["BRAVE_SEARCH_API_KEY"] == SECRET


def test_model_catalog_and_choice_for_image_generation(env):
    cat = env.get(f"{T}/image_gen/models").json()
    assert cat["has_models"] is True and [m["id"] for m in cat["models"]] == ["flux-2-pro", "flux-2-klein"] and cat["current"] == "flux-2-pro"
    assert env.put(f"{T}/image_gen/model", json={"model": "flux-2-klein"}).json()["model"] == "flux-2-klein"
    assert env.get(f"{T}/image_gen/models").json()["current"] == "flux-2-klein"
    assert env.put(f"{T}/image_gen/model", json={"model": "erfunden"}).status_code == 422
    assert env.put(f"{T}/web/model", json={"model": "flux-2-pro"}).status_code == 422  # Gruppe ohne Katalog
    assert env.get(f"{T}/web/models").json()["has_models"] is False


def test_terminal_backends_are_readable_and_changeable(env):
    body = env.get(f"{BASE}/terminal-backends").json()
    assert body["active"] == "local" and {b["name"] for b in body["backends"]} == {"local", "docker"}
    r = env.put(f"{BASE}/terminal-backend", json={"backend": "docker"})
    assert r.status_code == 200 and r.json() == {"ok": True, "backend": "docker"}
    assert env.get(f"{BASE}/terminal-backends").json()["active"] == "docker"
    assert ("PUT", "/api/tools/terminal/backend") in env.dash.state.tool_calls
    r = env.put(f"{BASE}/terminal-backend", json={"backend": "erfunden"})
    assert r.status_code == 422
    assert ("PUT", "/api/tools/terminal/backend") not in env.dash.state.tool_calls[-1:]
    env.put(f"{BASE}/terminal-backend", json={"backend": "local"})
    assert env.get(f"{BASE}/terminal-backends").json()["active"] == "local"


def test_post_setup_starts_and_names_the_background_action(env):
    r = env.post(f"{T}/web/post-setup", json={"key": "cua_driver"})
    assert r.status_code == 200 and r.json() == {"ok": True, "name": "tools-post-setup", "key": "cua_driver"}
    assert ("POST", "/api/tools/toolsets/web/post-setup") in env.dash.state.tool_calls
    assert env.post(f"{T}/gibtsnicht/post-setup", json={"key": "x"}).status_code == 404


def test_computer_use_status_shows_state_without_paths_or_versions(env):
    body = env.get(f"{BASE}/computer-use/status").json()
    assert body == {"ready": True, "installed": True, "can_grant": False, "granted": None, "platform": "linux", "detail": None}
    assert "sk-LEAK" not in env.get(f"{BASE}/computer-use/status").text and "/home/someone" not in env.get(f"{BASE}/computer-use/status").text


def test_computer_use_grant_starts_the_request(env):
    r = env.post(f"{BASE}/computer-use/grant")
    assert r.status_code == 200 and r.json() == {"ok": True, "name": "computer-use-grant"}
    assert ("POST", "/api/tools/computer-use/permissions/grant") in env.dash.state.tool_calls


@pytest.mark.parametrize("method,path,body", [
    ("PUT", "/tools/terminal/backend", {"backend": "local"}),
    ("POST", "/tools/computer-use/permissions/grant", {}),
    ("POST", "/env/reveal", {"key": "ANTHROPIC_API_KEY"}),
    ("PUT", "/env", {"key": "FOO", "value": "bar"}),
    ("DELETE", "/env", {"key": "ANTHROPIC_API_KEY"}),
])
def test_dangerous_hermes_routes_are_not_exposed(env, method, path, body):
    r = env.request(method, f"{BASE}{path}", json=body)
    assert r.status_code in (404, 405, 422)
    assert env.dash.state.tool_calls == [] and env.dash.state.post_setups == []


@pytest.mark.parametrize("method,path,body", [
    ("PUT", "/tools/web", {"enabled": True}),
    ("PUT", "/terminal-backend", {"backend": "docker"}),
    ("POST", "/tools/web/post-setup", {"key": "x"}),
    ("POST", "/computer-use/grant", {}),
    ("PUT", "/tools/web/provider", {"provider": "Firecrawl Cloud"}),
    ("PUT", "/tools/web/env", {"env": {"BRAVE_SEARCH_API_KEY": SECRET}}),
    ("PUT", "/tools/image_gen/model", {"model": "flux-2-klein"}),
])
def test_changes_need_a_fresh_login_and_reading_does_not(env, method, path, body):
    env.app.state.sessions.get(env.cookies.get(SESSION_COOKIE)).auth_time = 0
    assert env.get(T).status_code == 200 and env.get(f"{T}/web").status_code == 200
    r = env.request(method, f"{BASE}{path}", json=body)
    assert r.status_code == 401 and r.json()["detail"]["code"] == "step_up_required"
    assert [c for c in env.dash.state.tool_calls if c[0] != "GET"] == []


def test_audit_names_keys_and_toolsets_never_values(env):
    env.put(f"{T}/web/env", json={"env": {"BRAVE_SEARCH_API_KEY": SECRET}})
    env.put(f"{T}/web", json={"enabled": True})
    log = env.audit_file.read_text()
    assert "tools.env" in log and "BRAVE_SEARCH_API_KEY" in log and "tools.toggle" in log and SECRET not in log


def test_writes_are_rate_limited_per_user(env):
    env.app.state.limiter.per_minute = 5
    codes = [env.put(f"{T}/web", json={"enabled": bool(i % 2)}).status_code for i in range(10)]
    assert codes[:5] == [200] * 5 and set(codes[5:]) == {429}


def test_without_dashboard_the_page_gets_501(make_settings):
    app = create_app(make_settings(), transport=RouterTransport({"hermes.test": httpx.ASGITransport(app=create_mock(delay=0))}))
    with TestClient(app) as c:
        c.headers.update(HDR)
        assert c.get("/bff/h/laptop/hermes/default/tools").status_code == 501


def test_a_dashboard_that_drops_a_write_is_reported(tmp_path, make_settings):
    f = tmp_path / "hosts.json"
    rt = {"id": "hermes", "base_url": "http://hermes.test", "api_key": "k", "multiplex": True, "agents": ["default"], "dashboard": {"base_url": "http://dash.test"}}
    f.write_text(json.dumps({"hosts": [{"id": "server", "runtimes": [rt]}]}))
    dash = create_dashboard(drop_writes=True)
    app = create_app(make_settings(hosts_file=f), transport=RouterTransport({"hermes.test": httpx.ASGITransport(app=create_mock(delay=0)), "dash.test": httpx.ASGITransport(app=dash)}))
    with TestClient(app) as c:
        c.headers.update(HDR)
        r = c.put(f"{T}/web", json={"enabled": True})
        assert r.status_code == 502 and "nicht übernommen" in r.text
