import asyncio
import copy
import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.quota import AUTH_WORDS, RefreshGate, is_auth_failure, normalize, reset_in_s, strip_secrets
from devtools.mock_dashboard import create_mock as create_dashboard
from devtools.mock_hermes import create_mock
from tests.conftest import HDR, RouterTransport

# Echte (bereinigte) Antwort des Plugins auf dem Laptop; die Rechenzeit ist deren Abrufzeit.
REAL = json.loads((Path(__file__).parent / "fixtures" / "quota_usage_laptop.json").read_text())
T0 = 1792797155.0  # 2026-10-23T23:12:35Z
QUOTA = "/bff/h/server/hermes/default/quota"


def by_id(n):
    return {p["id"]: p for p in n["providers"]}


# --- Normalisierung mit der echten Fixture -----------------------------------------------------------------
def test_real_fixture_anthropic_is_ok_with_exact_remaining():
    a = by_id(normalize(REAL, T0))["anthropic"]
    assert a["state"] == "ok" and a["worst_remaining_percent"] == 73.0
    assert [(w["label"], w["used_percent"], w["remaining_percent"]) for w in a["windows"]] == [("Current session", 26.0, 74.0), ("Current week", 27.0, 73.0)]
    assert a["windows"][0]["reset_in_s"] == 13044  # 02:49:59 minus 23:12:35


def test_real_fixture_codex_session_is_exhausted_with_reset():
    c = by_id(normalize(REAL, T0))["openai-codex"]
    assert c["state"] == "exhausted" and c["worst_remaining_percent"] == 0.0 and c["plan"] == "Plus"
    assert c["windows"][0]["reset_in_s"] == 3572 and c["windows"][0]["reset_at"] == "2026-10-24T00:12:07+00:00"


def test_real_fixture_opencode_go_monthly_is_exhausted_other_windows_kept():
    g = by_id(normalize(REAL, T0))["opencode-go"]
    assert g["state"] == "exhausted" and [w["remaining_percent"] for w in g["windows"]] == [99.0, 68.0, 0.0]
    assert g["windows"][2]["detail"] == "status: rate-limited"


def test_real_fixture_copilot_date_only_reset_counts_from_midnight_utc():
    c = by_id(normalize(REAL, T0))["copilot"]
    assert c["state"] == "ok" and c["plan"] == "individual" and c["windows"][0]["reset_in_s"] == 694_045  # bis 2026-11-01T00:00Z


def test_real_fixture_nous_not_signed_in_is_auth_failed_with_reason():
    n = by_id(normalize(REAL, T0))["nous"]
    assert n["state"] == "auth_failed" and "Not signed in" in n["reason"] and n["windows"] == []


def test_real_fixture_providers_without_api_are_unavailable_not_failed():
    p = by_id(normalize(REAL, T0))
    for pid in ("custom", "gemini", "huggingface", "omniroute", "opencode-zen"):
        assert p[pid]["state"] == "unavailable" and p[pid]["reason"], pid
    assert p["gemini"]["reason"] == "No public subscription-quota API for this provider."


def test_unconfigured_inactive_provider_with_auth_words_is_only_unavailable():
    body = {"providers": [{"id": "x", "configured": False, "active": False, "quota_capable": True, "quota": {"available": False, "windows": [], "unavailable_reason": "401 unauthorized"}}]}
    assert normalize(body, T0)["providers"][0]["state"] == "unavailable"


@pytest.mark.parametrize("remaining,state", [(0.0, "exhausted"), (9.9, "low"), (10.0, "ok"), (55.0, "ok")])
def test_thresholds(remaining, state):
    body = {"providers": [{"id": "x", "configured": True, "quota": {"windows": [{"label": "w", "used_percent": 100 - remaining, "remaining_percent": remaining}]}}]}
    assert normalize(body, T0)["providers"][0]["state"] == state


def test_remaining_is_derived_when_only_used_is_given():
    body = {"providers": [{"id": "x", "quota": {"windows": [{"label": "w", "used_percent": 40.0}]}}]}
    assert normalize(body, T0)["providers"][0]["windows"][0]["remaining_percent"] == 60.0


@pytest.mark.parametrize("reason", ["HTTP 401", "Unauthorized", "token expired", "Invalid key", "Not signed in to X", "403 Forbidden"])
def test_auth_words_detect_access_problems(reason):
    assert is_auth_failure(reason)


@pytest.mark.parametrize("reason", [None, "", "No public subscription-quota API for this provider.", "Provider not in the Hermes catalog.", "timeout"])
def test_other_reasons_are_not_auth(reason):
    assert not is_auth_failure(reason)


def test_auth_word_list_is_lowercase():
    assert all(w == w.lower() for w in AUTH_WORDS)


# --- Zeitrechnung -------------------------------------------------------------------------------------------
def test_reset_in_s_handles_zones_dates_and_garbage():
    assert reset_in_s("2026-10-24T00:12:07+00:00", T0) == 3572
    assert reset_in_s("2026-10-24T02:12:07+02:00", T0) == 3572  # andere Zone, gleicher Zeitpunkt
    assert reset_in_s("2026-10-24T00:12:07Z", T0) == 3572
    assert reset_in_s("2026-10-24T00:12:07", T0) == 3572  # ohne Zone gilt UTC
    assert reset_in_s("2026-10-23", T0) == 0  # vergangen: nie negativ
    for bad in (None, "", "morgen", 5):
        assert reset_in_s(bad, T0) is None


# --- Geheimnisse --------------------------------------------------------------------------------------------
def test_secrets_are_dropped_recursively_but_data_survives():
    dirty = {"api_key": "x", "providers": [{"id": "a", "token": "t", "email": "m", "orgId": "o", "org_id": "o", "quota": {"plan": "Go", "access_token": "z", "windows": []}}],
             "remaining_percent": 5}
    clean = strip_secrets(dirty)
    assert clean == {"providers": [{"id": "a", "quota": {"plan": "Go", "windows": []}}], "remaining_percent": 5}
    dirty["providers"][0]["quota"]["windows"] = [{"label": "w", "remaining_percent": 1.0, "secret": "s"}]
    out = json.dumps(normalize(dirty, T0))
    assert '"t"' not in out and "orgId" not in out and "secret" not in out


def test_normalize_rejects_a_foreign_shape():
    assert normalize({"detail": "x"}, T0)["state"] == "error" and normalize("x", T0)["state"] == "error"


def test_refresh_gate_allows_one_per_window_and_key():
    g = RefreshGate(15)
    assert g.allow("a") and not g.allow("a") and g.allow("b")
    g2 = RefreshGate(0)
    assert g2.allow("a") and g2.allow("a")


# --- BFF-Routen -----------------------------------------------------------------------------------------------
@pytest.fixture
def build(make_settings):
    clients = []

    def make(quota=REAL, dashboard=None, running=True):
        dash = dashboard or create_dashboard(quota=quota)
        routes = {"hermes.test": httpx.ASGITransport(app=create_mock(delay=0))}
        if running:
            routes["dashboard.test"] = httpx.ASGITransport(app=dash)
        c = TestClient(create_app(make_settings(), transport=RouterTransport(routes)))
        c.__enter__()
        c.headers.update(HDR)
        c.dash = dash
        clients.append(c)
        return c
    yield make
    for c in clients:
        c.__exit__(None, None, None)


def test_route_returns_normalized_quota(build):
    body = build().get(QUOTA).json()
    assert body["state"] == "ok" and body["reason"] is None and body["cached"] is False
    assert by_id(body)["openai-codex"]["state"] == "exhausted"
    assert set(body["providers"][0]) >= {"id", "label", "configured", "active", "quota_capable", "plan", "state", "worst_remaining_percent", "windows", "reason"}


def test_route_passes_profile_and_defaults_to_cached(build):
    c = build()
    c.get(QUOTA)
    c.get("/bff/h/server/hermes/beta/quota")
    assert c.dash.state.quota_calls == [("default", 0), ("beta", 0)]


def test_missing_plugin_is_reported_honestly(build):
    body = build(quota=None).get(QUOTA).json()
    assert body["state"] == "plugin_missing" and body["reason"] == "Plugin ai-usage-tracker auf diesem Host nicht installiert" and body["providers"] == []


def test_offline_dashboard_is_dashboard_unavailable(build):
    body = build(running=False).get(QUOTA).json()
    assert body["state"] == "dashboard_unavailable" and "nicht erreichbar" in body["reason"]


def test_runtime_without_dashboard_is_reported_not_failed(build):
    body = build().get("/bff/h/laptop/hermes/default/quota").json()
    assert body["state"] == "dashboard_unavailable" and "kein Dashboard" in body["reason"]


def test_dashboard_token_rejection_is_an_error_state(make_settings):
    transport = RouterTransport({"hermes.test": httpx.ASGITransport(app=create_mock(delay=0)), "dashboard.test": httpx.ASGITransport(app=create_dashboard(token="geheim", quota=REAL))})
    with TestClient(create_app(make_settings(), transport=transport)) as c:
        c.headers.update(HDR)
        body = c.get(QUOTA).json()
    assert body["state"] == "error" and "Token" in body["reason"] and "geheim" not in json.dumps(body)


def test_refresh_is_rate_limited_per_profile(build):
    c = build()
    for _ in range(3):
        assert c.get(QUOTA + "?refresh=1").status_code == 200
    c.get("/bff/h/server/hermes/beta/quota?refresh=1")
    # je Profil nur das erste erzwungene Neuladen; die weiteren fallen auf den Cache zurück
    assert c.dash.state.quota_calls == [("default", 1), ("default", 0), ("default", 0), ("beta", 1)]


def test_refresh_value_is_validated(build):
    assert build().get(QUOTA + "?refresh=7").status_code == 422


def test_runtime_quota_lists_all_configured_profiles(build):
    c = build()
    body = c.get("/bff/h/server/hermes/_quota").json()
    assert set(body["profiles"]) == {"default", "beta", "ghost", "eta"}  # "../evil" fällt beim Laden der Config weg
    assert all(q["state"] == "ok" for q in body["profiles"].values())
    assert by_id(body["profiles"]["default"])["nous"]["state"] == "auth_failed"


def test_runtime_quota_timeout_is_per_profile(build, monkeypatch):
    import app.routes.dashboard as r
    from app.dashboard import DashboardClient
    orig = DashboardClient.quota

    async def quota(self, name, refresh):
        if name == "beta":
            await asyncio.sleep(1)
        return await orig(self, name, refresh)

    monkeypatch.setattr(r, "QUOTA_TIMEOUT_S", 0.05)
    monkeypatch.setattr(DashboardClient, "quota", quota)
    profiles = build().get("/bff/h/server/hermes/_quota").json()["profiles"]
    assert profiles["beta"]["state"] == "error" and "rechtzeitig" in profiles["beta"]["reason"]
    assert profiles["default"]["state"] == "ok"


def test_runtime_quota_unknown_host_is_404(build):
    assert build().get("/bff/h/nope/hermes/_quota").status_code == 404


def test_summary_names_the_worst_window_and_expired_access(build):
    body = build().get("/bff/quota/summary").json()
    assert body["runtimes"][0] == {"host": "server", "runtime": "hermes", "state": "ok", "reason": None}
    mine = [i for i in body["items"] if i["profile"] == "default"]
    codex = next(i for i in mine if i["provider"] == "openai-codex")
    assert (codex["state"], codex["remaining_percent"], codex["window"], codex["reset_in_s"] is not None) == ("exhausted", 0.0, "Session", True)
    nous = next(i for i in mine if i["provider"] == "nous")
    assert nous["state"] == "auth_failed" and nous["remaining_percent"] is None and "Not signed in" in nous["reason"]
    assert not any(i["provider"] == "gemini" for i in mine)
    assert body["worst"]["state"] in ("auth_failed", "exhausted")


def test_summary_without_plugin_shows_runtime_state_and_no_items(build):
    body = build(quota=None).get("/bff/quota/summary").json()
    assert body["items"] == [] and body["worst"] is None and body["runtimes"][0]["state"] == "plugin_missing"


def test_quota_routes_are_behind_current_user():
    from app.routes import dashboard as r
    assert all(rt.dependencies for rt in (r.router, r.host_router, r.quota_router))
