import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.providers import build_overview, provider_keys
from devtools.mock_dashboard import create_mock as create_dashboard
from devtools.mock_hermes import create_mock
from tests.conftest import BASE, HDR, RouterTransport

P = f"{BASE}/providers"
SECRET = "sk-ant-geheim-1234"


class Flaky(httpx.AsyncBaseTransport):
    """Reicht an das Mock-Dashboard weiter, lässt aber die genannten Pfade mit 500 scheitern."""

    def __init__(self, app, broken):
        self.inner, self.broken = httpx.ASGITransport(app=app), broken

    async def handle_async_request(self, request):
        if request.url.path in self.broken:
            return httpx.Response(500, request=request)
        return await self.inner.handle_async_request(request)


@pytest.fixture
def dash():
    return create_dashboard()


@pytest.fixture
def make(make_settings, dash):
    clients = []

    def build(broken=(), running=True):
        routes = {"hermes.test": httpx.ASGITransport(app=create_mock(delay=0))}
        if running:
            routes["dashboard.test"] = Flaky(dash, set(broken))
        c = TestClient(create_app(make_settings(), transport=RouterTransport(routes)))
        c.__enter__()
        c.headers.update(HDR)
        clients.append(c)
        return c
    yield build
    for c in clients:
        c.__exit__(None, None, None)


@pytest.fixture
def client(make):
    return make()


def by_id(body):
    return {p["id"]: p for p in body["providers"]}


# --- Normalisierung --------------------------------------------------------------------------------------
def test_overview_groups_keys_logins_and_usage():
    env = {
        "ANTHROPIC_API_KEY": {"provider": "anthropic", "provider_label": "Anthropic", "category": "provider", "is_set": True, "redacted_value": "sk-a…1234", "is_password": True},
        "ANTHROPIC_TOKEN": {"provider": "anthropic", "provider_label": "Anthropic", "category": "provider", "is_set": False},
        "TELEGRAM_BOT_TOKEN": {"category": "messaging", "channel_managed": True, "is_set": True},
        "FIRECRAWL_API_KEY": {"category": "tool", "provider": "", "is_set": True},
        "ODD_KEY": {"category": "provider", "is_set": True, "redacted_value": "…"},
    }
    oauth = {"providers": [{"id": "openai-codex", "name": "OpenAI Codex", "flow": "device_code", "cli_command": "hermes auth add openai-codex", "status": {"logged_in": True, "source_label": "Datei"}}]}
    usage = {"models": [
        {"model": "a", "provider": "anthropic", "sessions": 2, "input_tokens": 10, "output_tokens": 5, "estimated_cost": 1.0, "actual_cost": 0.5, "last_used_at": 5},
        {"model": "b", "provider": "anthropic", "sessions": 1, "input_tokens": 1, "output_tokens": 1, "estimated_cost": 2.0, "actual_cost": 0, "last_used_at": 9},
        {"model": "x", "provider": "ollama", "sessions": 1, "input_tokens": 3, "output_tokens": 0},
    ]}
    out = build_overview(env, oauth, usage, 30)
    got = by_id(out)
    assert set(got) == {"anthropic", "openai-codex", "ODD_KEY", "ollama"}  # Kanal- und Werkzeug-Keys gehören nicht dazu
    a = got["anthropic"]
    assert a["configured"] and a["used"] and [k["var"] for k in a["keys"]] == ["ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN"]
    assert a["usage"] == {"sessions": 3, "input_tokens": 11, "output_tokens": 6, "cost_usd": 2.5, "last_used_at": 9, "models": ["a", "b"]}  # echte Kosten vor geschätzten
    assert got["openai-codex"]["configured"] and got["openai-codex"]["oauth"]["logged_in"] and got["openai-codex"]["label"] == "OpenAI Codex"
    assert got["ollama"]["used"] and not got["ollama"]["configured"]
    ids = [p["id"] for p in out["providers"]]
    assert ids[0] == "anthropic" and ids[-1] == "ollama" and out["period_days"] == 30  # eingerichtet vor "nur genutzt"


@pytest.mark.parametrize("junk", [None, [], "x", {"providers": "kaputt"}, {"models": [1, "a", None]}])
def test_overview_survives_unexpected_shapes(junk):
    assert build_overview(junk, junk, junk, 7) == {"providers": [], "period_days": 7}
    assert provider_keys(junk) == {}


# --- Übersicht -------------------------------------------------------------------------------------------
def test_overview_route_never_returns_key_values(client):
    r = client.get(P)
    assert r.status_code == 200 and SECRET not in r.text
    got = by_id(r.json())
    assert got["anthropic"]["configured"] and got["anthropic"]["keys"][0]["redacted"] == "sk-a…1234"
    assert got["openai-codex"]["oauth"]["logged_in"] and not got["openrouter"]["configured"] and not got["gemini"]["used"]
    assert [p["id"] for p in r.json()["providers"]][:3] == ["anthropic", "openai-codex", "ollama"]
    assert r.json()["warnings"] == [] and r.json()["period_days"] == 30


def test_other_profile_has_its_own_keys(client):
    got = by_id(client.get(f"{BASE.replace('/default', '/beta')}/providers?days=7").json())
    assert not got["anthropic"]["keys"][0]["set"] and not got["anthropic"]["configured"] and got["anthropic"]["used"]


def test_missing_side_sources_become_warnings_not_errors(make):
    body = make(broken={"/api/providers/oauth", "/api/analytics/models"}).get(P).json()
    assert len(body["warnings"]) == 2 and all("nicht ladbar" in w for w in body["warnings"])
    got = by_id(body)
    assert got["anthropic"]["configured"] and got["anthropic"]["usage"] is None and got["anthropic"]["oauth"] is None


def test_keys_are_required_for_the_overview(make):
    assert make(broken={"/api/env"}).get(P).status_code == 502
    assert make(running=False).get(P).status_code == 503


def test_overview_without_dashboard_is_501(client):
    assert client.get("/bff/h/laptop/hermes/default/providers").status_code == 501


# --- Key prüfen und speichern ----------------------------------------------------------------------------
def audit_entries(tmp_path):
    return [json.loads(line) for line in (tmp_path / "audit.log").read_text().splitlines()]


def test_write_key_stores_it_and_never_logs_or_returns_it(client, dash, tmp_path):
    r = client.put(f"{P}/key", json={"var": "OPENROUTER_API_KEY", "value": "sk-or-supergeheim"})
    assert r.status_code == 200 and r.json() == {"ok": True, "var": "OPENROUTER_API_KEY"}
    assert dash.state.profiles["default"]["env"]["OPENROUTER_API_KEY"] == "sk-or-supergeheim"
    assert by_id(client.get(P).json())["openrouter"]["configured"]
    entry = audit_entries(tmp_path)[-1]
    assert entry["action"] == "provider.key" and entry["detail"] == {"var": "OPENROUTER_API_KEY", "chars": 17}
    assert "supergeheim" not in (tmp_path / "audit.log").read_text() and "supergeheim" not in client.get(P).text


@pytest.mark.parametrize("var", ["PATH", "FIRECRAWL_API_KEY", "TELEGRAM_BOT_TOKEN", "NOT_IN_CATALOG"])
def test_only_provider_variables_can_be_set(client, dash, var):
    r = client.put(f"{P}/key", json={"var": var, "value": "x1"})
    assert r.status_code == 422 and "keinem Anbieter" in r.json()["detail"]
    assert var not in dash.state.profiles["default"]["env"]


def test_validate_ok_reachable_false_does_not_store(make, dash, tmp_path):
    client = make()
    body = client.post(f"{P}/validate", json={"var": "OPENROUTER_API_KEY", "value": "offline"}).json()
    assert body == {"ok": False, "reachable": False, "message": "Could not reach the provider to verify the key."}
    assert "OPENROUTER_API_KEY" not in dash.state.profiles["default"]["env"]


def test_write_key_shows_dashboard_reason(make, dash):
    dash.state.env_put_error = {"var": "OPENROUTER_API_KEY", "status": 500, "detail": "Speichern derzeit gesperrt"}
    r = make().put(f"{P}/key", json={"var": "OPENROUTER_API_KEY", "value": "sk-or-x"})
    assert r.status_code == 502 and r.json()["detail"] == "Das Dashboard meldet Fehler 500: Speichern derzeit gesperrt"


def test_write_key_unknown_variable_422(make_settings, dash):
    dash.state.env_put_error = {"var": "OPENROUTER_API_KEY", "status": 422, "detail": "unknown variable"}
    routes = {"hermes.test": httpx.ASGITransport(app=create_mock(delay=0)), "dashboard.test": httpx.ASGITransport(app=dash)}
    with TestClient(create_app(make_settings(), transport=RouterTransport(routes))) as c:
        c.headers.update(HDR)
        r = c.put(f"{P}/key", json={"var": "OPENROUTER_API_KEY", "value": "sk-or-x"})
        assert r.status_code == 502 and "unknown variable" in r.json()["detail"]


@pytest.mark.parametrize("body", [
    {"var": "anthropic_api_key", "value": "x"}, {"var": "A", "value": "x"}, {"var": "ANTHROPIC_API_KEY", "value": ""},
    {"var": "ANTHROPIC_API_KEY", "value": "zwei\nzeilen"}, {"var": "ANTHROPIC_API_KEY", "value": " rand "}, {"var": "ANTHROPIC_API_KEY"},
])
def test_key_input_is_validated(client, body):
    assert client.put(f"{P}/key", json=body).status_code == 422
    assert client.post(f"{P}/validate", json=body).status_code == 422


def test_rejected_input_is_not_echoed_back(client):
    r = client.put(f"{P}/key", json={"var": "OPENROUTER_API_KEY", "value": "geheim\nzeile"})
    assert r.status_code == 422 and "geheim" not in r.text and r.json()["detail"][0]["loc"] == ["body", "value"]


def test_validate_passes_the_providers_verdict_through(client, dash, tmp_path):
    def check(value):
        return client.post(f"{P}/validate", json={"var": "OPENROUTER_API_KEY", "value": value}).json()
    assert check("gut") == {"ok": True, "reachable": True, "message": ""}
    assert check("bad") == {"ok": False, "reachable": True, "message": "That API key was rejected. Double-check it and try again."}
    assert check("offline")["reachable"] is False
    assert "OPENROUTER_API_KEY" not in dash.state.profiles["default"]["env"]  # prüfen speichert nichts
    assert audit_entries(tmp_path)[-1]["action"] == "provider.validate" and "bad" not in json.dumps(audit_entries(tmp_path))


def test_key_routes_require_csrf_header_and_known_agent(client):
    assert client.put(f"{P}/key", json={"var": "OPENROUTER_API_KEY", "value": "k"}, headers={"X-Requested-With": ""}).status_code == 403
    assert client.put("/bff/h/server/hermes/ghost-agent/providers/key", json={"var": "OPENROUTER_API_KEY", "value": "k"}).status_code == 404


# --- Anbieter-Hauptseite: alle Profile einer Runtime, Modelle, Anmeldung ------------------------------------
MATRIX = "/bff/h/server/hermes/_provider-matrix"


def test_matrix_lists_profiles_with_provider_and_model_and_the_three_accounts(client, dash):
    dash.state.profiles["default"]["env"]["OPENCODE_GO_API_KEY"] = "ocg-geheim-9999"
    body = client.get(MATRIX).json()
    assert body["available"] is True and body["reason"] is None
    rows = {p["name"]: p for p in body["profiles"]}
    # die Config führt default, beta, ghost und eta; das Dashboard kennt ghost nicht
    assert set(rows) == {"default", "beta", "eta"}
    assert rows["beta"]["provider"] == "anthropic" and rows["beta"]["model"] == "claude-test"
    acc = {a["id"]: a for a in body["accounts"]}
    assert [a["id"] for a in body["accounts"]] == ["codex", "claude", "opencode-go"]
    assert acc["codex"]["profiles"]["default"] == {"configured": True, "via": "login", "detail": "~/.codex/auth.json"}
    assert acc["claude"]["profiles"]["default"]["via"] == "key" and acc["claude"]["profiles"]["beta"]["configured"] is False
    assert acc["opencode-go"]["profiles"]["default"]["configured"] is True
    assert acc["opencode-go"]["profiles"]["eta"]["configured"] is False
    text = json.dumps(body)
    assert "ocg-geheim-9999" not in text and SECRET not in text  # nur geschwärzt


def test_matrix_without_a_dashboard_still_lists_the_configured_profiles(client):
    body = client.get("/bff/h/laptop/hermes/_provider-matrix").json()
    assert body["available"] is False and "kein Dashboard" in body["reason"]
    assert [p["name"] for p in body["profiles"]] == ["default"] and body["profiles"][0]["provider"] is None
    assert [a["id"] for a in body["accounts"]] == ["codex", "claude", "opencode-go"] and body["accounts"][0]["profiles"] == {}


def test_matrix_when_the_dashboard_is_down_explains_instead_of_failing(make):
    body = make(running=False).get(MATRIX).json()
    assert body["available"] is False and "nicht erreichbar" in body["reason"] and body["profiles"]


def test_matrix_keeps_a_profile_whose_query_failed(make):
    body = make(broken={"/api/env"}).get(MATRIX).json()
    assert body["available"] is True and all(p["error"] for p in body["profiles"])
    assert all(a["profiles"] == {} for a in body["accounts"])


def test_unknown_host_or_runtime_is_404(client):
    assert client.get("/bff/h/nope/hermes/_provider-matrix").status_code == 404
    assert client.get("/bff/h/server/opencode/_provider-matrix").status_code == 404


def test_model_options_are_normalized_current_first(client):
    body = client.get(f"{P}/models").json()
    slugs = [p["slug"] for p in body["providers"]]
    assert slugs[0] == "anthropic" and body["providers"][0]["current"] is True  # das Profil nutzt anthropic
    assert slugs.index("openai-codex") < slugs.index("opencode-go")  # angemeldete vor nicht angemeldeten
    assert body["providers"][0]["models"] == ["claude-test", "claude-small"]


def test_device_login_start_and_poll(client):
    start = client.post(f"{P}/oauth/openai-codex/start").json()
    assert start["user_code"] == "ABCD-EFGH" and start["verification_url"].startswith("https://") and start["session_id"]
    poll = client.get(f"{P}/oauth/openai-codex/poll/{start['session_id']}").json()
    assert poll["status"] == "pending"
    assert client.get(f"{P}/oauth/openai-codex/poll/unbekannt-12345").status_code == 404


def test_pkce_login_needs_the_code_and_reports_a_wrong_one(client, tmp_path):
    start = client.post(f"{P}/oauth/anthropic/start").json()
    assert start["auth_url"].startswith("https://")
    bad = client.post(f"{P}/oauth/anthropic/submit", json={"session_id": start["session_id"], "code": "falsch"}).json()
    assert bad["ok"] is False
    ok = client.post(f"{P}/oauth/anthropic/submit", json={"session_id": start["session_id"], "code": "gueltig"}).json()
    assert ok["ok"] is True
    audit = [json.loads(l) for l in (tmp_path / "audit.log").read_text().splitlines()]
    assert [a["action"] for a in audit if a["action"].startswith("provider.login")] == ["provider.login.start", "provider.login.submit", "provider.login.submit"]
    assert "gueltig" not in (tmp_path / "audit.log").read_text()


def test_login_for_an_external_cli_provider_is_refused_with_a_reason(client):
    r = client.post(f"{P}/oauth/claude-code/start")
    assert r.status_code == 502 and "Dashboard" in r.json()["detail"]


def test_login_provider_ids_are_checked(client):
    assert client.post(f"{P}/oauth/..%2Fetc/start").status_code in (404, 422)
    assert client.post(f"{P}/oauth/UPPER/start").status_code == 422
