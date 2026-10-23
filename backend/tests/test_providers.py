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
    got = by_id(client.get(f"{BASE.replace('/default', '/omoikane')}/providers?days=7").json())
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
    assert client.put("/bff/h/hikari/hermes/ghost-agent/providers/key", json={"var": "OPENROUTER_API_KEY", "value": "k"}).status_code == 404
