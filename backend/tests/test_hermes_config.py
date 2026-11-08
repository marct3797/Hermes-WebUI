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


def test_env_delete_needs_the_typed_key_and_reports_missing(env):
    assert env.request("DELETE", f"{BASE}/env/ANTHROPIC_API_KEY", json={"key": "ANTHROPIC_API_KEY", "confirm": "falsch"}).status_code == 422
    assert env.request("DELETE", f"{BASE}/env/GIBTSNICHT_KEY", json={"key": "GIBTSNICHT_KEY", "confirm": "GIBTSNICHT_KEY"}).status_code == 404
    assert env.request("DELETE", f"{BASE}/env/klein", json={"key": "klein", "confirm": "klein"}).status_code == 422
    r = env.request("DELETE", f"{BASE}/env/ANTHROPIC_API_KEY", json={"key": "ANTHROPIC_API_KEY", "confirm": "ANTHROPIC_API_KEY"})
    assert r.status_code == 200 and r.json() == {"ok": True, "key": "ANTHROPIC_API_KEY"}
    assert "ANTHROPIC_API_KEY" in open(env.audit_file).read()


# --- Provider-Routing -------------------------------------------------------------------------------------------------------------
RT = f"{BASE}/provider-routing"
FULL = {"sort": "throughput", "only": ["anthropic"], "ignore": ["deepinfra"], "order": ["anthropic", "google-vertex"], "require_parameters": True, "data_collection": "deny"}


def test_routing_defaults_when_nothing_is_configured(env):
    body = env.get(RT).json()
    assert body["routing"] == {"sort": None, "only": [], "ignore": [], "order": [], "require_parameters": False, "data_collection": None}
    assert body["per_model"] == []


def test_routing_is_written_in_full_and_read_back(env):
    r = env.put(RT, json=FULL)
    assert r.status_code == 200 and r.json()["routing"] == FULL
    assert env.dash.state.profiles["default"]["config"]["provider_routing"] == FULL
    assert env.get(RT).json()["routing"] == FULL


def test_routing_reset_removes_old_values_despite_deep_merge(env):
    env.put(RT, json=FULL)
    cleared = {"sort": None, "only": [], "ignore": [], "order": [], "require_parameters": False, "data_collection": None}
    assert env.put(RT, json=cleared).json()["routing"] == cleared
    assert env.get(RT).json()["routing"] == cleared


def test_routing_keeps_per_model_overrides_and_lists_them(env):
    env.dash.state.profiles["default"]["config"]["provider_routing"] = {"sort": "latency", "models": {"anthropic/x": {"only": ["anthropic"]}}}
    assert env.get(RT).json()["per_model"] == ["anthropic/x"]
    env.put(RT, json=FULL)
    assert env.dash.state.profiles["default"]["config"]["provider_routing"]["models"] == {"anthropic/x": {"only": ["anthropic"]}}


def test_routing_unset_sort_is_the_neutral_value_and_overwrites_an_old_one(env):
    """Hermes-Standard ist „nicht gesetzt“: Speichern darf keine Preis-Sortierung erzwingen."""
    assert env.get(RT).json()["routing"]["sort"] is None
    env.put(RT, json={**FULL, "sort": "latency"})
    assert env.put(RT, json={**FULL, "sort": None}).json()["routing"]["sort"] is None
    assert env.dash.state.profiles["default"]["config"]["provider_routing"]["sort"] is None
    env.dash.state.profiles["default"]["config"].pop("provider_routing")
    assert env.put(RT, json={}).json()["routing"]["sort"] is None


def test_routing_null_removes_data_collection_like_hermes_merge(env):
    """Die Tiefenmischung von Hermes ignoriert `None` nur über einem Abschnitt, über einem Wert überschreibt es: `data_collection` lässt sich leeren."""
    env.put(RT, json=FULL)
    assert env.put(RT, json={**FULL, "data_collection": None}).json()["routing"]["data_collection"] is None


def test_mock_merge_matches_hermes_deep_merge():
    """Gegen den echten Merge-Pfad: `_deep_merge` aus dem Hermes-Quelltext (Umgebungsvariable HERMES_AGENT_SRC), sonst übersprungen."""
    import ast, os, pathlib
    src = os.environ.get("HERMES_AGENT_SRC")
    if not src or not (pathlib.Path(src) / "hermes_cli" / "config.py").exists():
        pytest.skip("HERMES_AGENT_SRC nicht gesetzt")
    text = (pathlib.Path(src) / "hermes_cli" / "config.py").read_text()
    node = next(n for n in ast.parse(text).body if isinstance(n, ast.FunctionDef) and n.name == "_deep_merge")
    ns: dict = {}
    exec(compile(ast.Module([node], []), "config.py", "exec"), ns)
    import copy
    from devtools.mock_dashboard import deep_merge
    base = {"provider_routing": {"sort": "latency", "only": ["a"], "data_collection": "deny", "models": {"m": {"only": ["x"]}}}, "terminal": {"cwd": "/"}}
    for extra in (
        {"provider_routing": FULL},
        {"provider_routing": {**FULL, "sort": None}},
        {"provider_routing": {**FULL, "data_collection": None, "only": []}},
        {"terminal": None},
        {"provider_routing": None},
        {"provider_routing": {"sort": "price"}},
    ):
        assert deep_merge(copy.deepcopy(base), copy.deepcopy(extra)) == ns["_deep_merge"](copy.deepcopy(base), copy.deepcopy(extra))


@pytest.mark.parametrize("bad", [{"sort": "cheap"}, {"only": ["Anthropic"]}, {"order": ["a", "a"]}, {"extra": 1}, {"data_collection": "maybe"}, {"only": ["x y"]}])
def test_routing_rejects_invalid_input(env, bad):
    assert env.put(RT, json=bad).status_code == 422


def test_routing_needs_a_fresh_login_and_is_audited_without_values(env):
    env.put(RT, json=FULL)
    assert "profile.provider_routing" in env.audit_file.read_text() and "deepinfra" not in env.audit_file.read_text()
    env.app.state.sessions.get(env.cookies.get(SESSION_COOKIE)).auth_time = 0
    assert env.put(RT, json=FULL).status_code == 401


# --- Geheimnisse in verschachtelten Werten ------------------------------------------------------------------------------------------
def test_nested_secrets_never_reach_the_browser_and_survive_an_edit(env):
    stored = [{"provider": "custom", "model": "m1", "base_url": "http://x/v1", "api_key": "sk-geheim-1", "api_key_env": "X_KEY"},
              {"provider": "openrouter", "model": "m2", "api_key": "sk-geheim-2"}]
    env.dash.state.profiles["default"]["config"]["fallback_providers"] = stored
    shown = env.get(CFG)
    assert "sk-geheim" not in shown.text
    value = fields(env)["fallback_providers"]["value"]
    assert value[0] == {"provider": "custom", "model": "m1", "base_url": "http://x/v1", "api_key_env": "X_KEY"}  # api_key_env ist nur ein Name
    value.reverse()  # umsortiert und Modell geändert
    value[0]["model"] = "m2b"
    assert env.put(CFG, json={"changes": {"fallback_providers": value}}).status_code == 200
    now = env.dash.state.profiles["default"]["config"]["fallback_providers"]
    assert now[0]["api_key"] == "sk-geheim-2" and now[0]["model"] == "m2b"
    assert now[1]["api_key"] == "sk-geheim-1" and now[1]["base_url"] == "http://x/v1"


def test_a_new_or_changed_provider_entry_gets_no_foreign_secret_and_secrets_cannot_be_written(env):
    env.dash.state.profiles["default"]["config"]["fallback_providers"] = [{"provider": "custom", "model": "m1", "api_key": "sk-geheim-1"}]
    assert env.put(CFG, json={"changes": {"fallback_providers": [{"provider": "nous", "model": "m"}]}}).status_code == 200
    assert "api_key" not in env.dash.state.profiles["default"]["config"]["fallback_providers"][0]
    r = env.put(CFG, json={"changes": {"fallback_providers": [{"provider": "nous", "model": "m", "api_key": "sk-neu"}]}})
    assert r.status_code == 422 and "sk-neu" not in env.dash.state.profiles["default"]["config"]["fallback_providers"][0].values()


def test_secrets_follow_provider_model_and_base_url_not_the_position(env):
    """Zwei Einträge desselben Anbieters mit verschiedener base_url: Umsortieren und Modellwechsel dürfen die Schlüssel nicht vertauschen."""
    env.dash.state.profiles["default"]["config"]["fallback_providers"] = [
        {"provider": "custom", "model": "a", "base_url": "http://eins/v1", "api_key": "sk-eins"},
        {"provider": "custom", "model": "a", "base_url": "http://zwei/v1", "api_key": "sk-zwei"}]
    value = fields(env)["fallback_providers"]["value"]
    value.reverse()
    value[0]["model"] = "b"  # base_url zwei, Modell geändert
    assert env.put(CFG, json={"changes": {"fallback_providers": value}}).status_code == 200
    now = env.dash.state.profiles["default"]["config"]["fallback_providers"]
    assert (now[0]["base_url"], now[0]["api_key"]) == ("http://zwei/v1", "sk-zwei")
    assert (now[1]["base_url"], now[1]["api_key"]) == ("http://eins/v1", "sk-eins")
