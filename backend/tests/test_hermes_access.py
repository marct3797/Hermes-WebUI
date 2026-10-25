"""Pairing und Webhooks (Punkt 10): wer darf mit dem Agenten sprechen, was löst ihn von außen aus.

Schranken des BFF (Hermes prüft das nicht selbst):
- Freigeben/Sperren/Anlegen/Ändern/Löschen nur mit frischer Anmeldung, Sperren und Löschen zusätzlich mit eingetipptem Namen,
- Freigeben nur über die angezeigte Anfrage-ID (kein Code-Raten über die Oberfläche),
- Webhooks: kein `script` (würde Programme auf dem Host starten), kein selbst gewähltes Secret (Hermes erzeugt ein starkes),
  das Secret erscheint genau einmal in der Antwort (no-store), nie im Audit und nie in der Liste,
- Plattform einschalten startet das Gateway neu: nur mit ausdrücklicher Bestätigung,
- jede Änderung wird zurückgelesen. Hooks (führen Shell-Befehle aus) bleiben bewusst aus.
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

P, W = f"{BASE}/hermes-pairing", f"{BASE}/hermes-webhooks"
GOOD = {"name": "github-push", "description": "Push-Ereignisse", "events": ["push"], "prompt": "Fasse zusammen: {message}", "skills": [], "deliver": "log"}


def _client(tmp_path, make_settings, drop_writes):
    f = tmp_path / "a-hosts.json"
    rt = {"id": "hermes", "base_url": "http://hermes.test", "api_key": "k", "multiplex": True, "agents": ["default", "beta"], "dashboard": {"base_url": "http://dash.test"}}
    f.write_text(json.dumps({"hosts": [{"id": "server", "runtimes": [rt]}]}))
    dash = create_dashboard(drop_writes=drop_writes)
    settings = make_settings(hosts_file=f, auth_mode="oidc", oidc_issuer="https://id.test", oidc_client_id="t", oidc_client_secret="t", oidc_allowed_sub="user", public_url="http://testserver")
    app = create_app(settings, transport=RouterTransport({"hermes.test": httpx.ASGITransport(app=create_mock(delay=0)), "dash.test": httpx.ASGITransport(app=dash)}))
    with TestClient(app) as c:
        s = app.state.sessions.create(User("user", "Test"))
        s.auth_time = app.state.sessions.now()
        c.cookies.set(SESSION_COOKIE, s.id)
        c.headers.update(HDR)
        c.dash, c.audit_file = dash, settings.audit_file
        c.dash.state.profiles["default"]["pairing"] = {"pending": [{"platform": "telegram", "request_id": "req-1", "user_id": "42", "user_name": "Anna", "age_minutes": 3}],
                                                       "approved": [{"platform": "telegram", "user_id": "7", "user_name": "Bob", "approved_at": 1.0}]}
        yield c


@pytest.fixture
def env(tmp_path, make_settings):
    yield from _client(tmp_path, make_settings, False)


@pytest.fixture
def lossy(tmp_path, make_settings):
    yield from _client(tmp_path, make_settings, True)


def stale(env):
    env.app.state.sessions.get(env.cookies.get(SESSION_COOKIE)).auth_time = 0


def fresh(env):
    env.app.state.sessions.get(env.cookies.get(SESSION_COOKIE)).auth_time = env.app.state.sessions.now()


def enable(env):
    assert env.post(f"{W}/enable", json={"confirm_restart": True}).status_code == 200


# ---- Pairing ----
def test_pairing_list_shows_requests_and_never_a_code(env):
    b = env.get(P).json()
    assert b["pending"][0]["request_id"] == "req-1" and b["approved"][0]["user_id"] == "7"
    assert "code" not in json.dumps(b).lower()


def test_approve_needs_fresh_and_request_id_only_and_reads_back(env):
    stale(env)
    assert env.post(f"{P}/approve", json={"platform": "telegram", "request_id": "req-1"}).status_code == 401
    fresh(env)
    assert env.post(f"{P}/approve", json={"platform": "telegram", "request_id": "req-1", "code": "ABCD1234"}).status_code == 422  # Code-Raten bleibt aus
    assert env.post(f"{P}/approve", json={"platform": "Tele gram!", "request_id": "req-1"}).status_code == 422
    assert env.post(f"{P}/approve", json={"platform": "telegram", "request_id": ""}).status_code == 422  # Altbestand ohne ID: nicht per Oberfläche
    assert env.post(f"{P}/approve", json={"platform": "telegram", "request_id": "weg"}).status_code == 404
    r = env.post(f"{P}/approve", json={"platform": "telegram", "request_id": "req-1"})
    assert r.status_code == 200
    b = env.get(P).json()
    assert b["pending"] == [] and {a["user_id"] for a in b["approved"]} == {"7", "42"}


def test_revoke_needs_fresh_and_typed_user_id(env):
    stale(env)
    assert env.post(f"{P}/revoke", json={"platform": "telegram", "user_id": "7", "confirm": "7"}).status_code == 401
    fresh(env)
    assert env.post(f"{P}/revoke", json={"platform": "telegram", "user_id": "7", "confirm": "falsch"}).status_code == 422
    assert len(env.get(P).json()["approved"]) == 1
    assert env.post(f"{P}/revoke", json={"platform": "telegram", "user_id": "7", "confirm": "7"}).status_code == 200
    assert env.get(P).json()["approved"] == []


def test_dropped_pairing_writes_are_not_success(lossy):
    assert lossy.post(f"{P}/approve", json={"platform": "telegram", "request_id": "req-1"}).status_code == 502
    assert lossy.post(f"{P}/revoke", json={"platform": "telegram", "user_id": "7", "confirm": "7"}).status_code == 502


# ---- Webhooks ----
def test_enable_needs_fresh_and_explicit_restart_confirmation(env):
    stale(env)
    assert env.post(f"{W}/enable", json={"confirm_restart": True}).status_code == 401
    fresh(env)
    assert env.post(f"{W}/enable", json={"confirm_restart": False}).status_code == 422
    assert env.post(f"{W}/enable", json={}).status_code == 422
    assert env.get(W).json()["enabled"] is False
    enable(env)
    assert env.get(W).json()["enabled"] is True


def test_create_is_refused_while_platform_is_off(env):
    assert env.post(W, json=GOOD).status_code == 409


@pytest.mark.parametrize("bad", [
    {"script": "/bin/evil.sh"}, {"secret": "schwach"}, {"name": "Gross Name!"}, {"name": ""},
    {"deliver_only": True, "deliver": "log"}, {"events": ["e"] * 21}, {"prompt": "x" * 4001}, {"skills": ["s"] * 21}, {"deliver": "Teleg ram"},
])
def test_create_rejects_dangerous_or_malformed_input(env, bad):
    enable(env)
    r = env.post(W, json={**GOOD, **bad})
    assert r.status_code == 422, (bad, r.text)
    assert env.get(W).json()["subscriptions"] == []


def test_create_shows_secret_exactly_once_and_never_logs_it(env):
    enable(env)
    stale(env)
    assert env.post(W, json=GOOD).status_code == 401
    fresh(env)
    r = env.post(W, json=GOOD)
    assert r.status_code == 200 and r.json()["secret"].startswith("whsec-") and "no-store" in r.headers["cache-control"]
    secret = r.json()["secret"]
    env.dash.state.leaky = True  # ein Dashboard, das das Secret doch mitschickt: das BFF filtert es
    listing = env.get(W)
    assert secret not in listing.text and listing.json()["subscriptions"][0]["secret_set"] is True
    assert secret not in env.audit_file.read_text()


def test_toggle_and_delete_need_fresh_typed_name_and_read_back(env):
    enable(env)
    env.post(W, json=GOOD)
    stale(env)
    assert env.put(f"{W}/github-push/enabled", json={"enabled": False}).status_code == 401
    fresh(env)
    assert env.put(f"{W}/github-push/enabled", json={"enabled": False}).status_code == 200
    assert env.get(W).json()["subscriptions"][0]["enabled"] is False
    assert env.request("DELETE", f"{W}/github-push", params={"confirm": "falsch"}).status_code == 422
    assert env.request("DELETE", f"{W}/github-push").status_code == 422
    assert len(env.get(W).json()["subscriptions"]) == 1
    assert env.request("DELETE", f"{W}/github-push", params={"confirm": "github-push"}).status_code == 200
    assert env.get(W).json()["subscriptions"] == []
    assert env.put(f"{W}/../x/enabled", json={"enabled": True}).status_code in (404, 405, 422)


def test_dropped_webhook_writes_are_not_success_and_leak_no_secret(lossy):
    lossy.dash.state.profiles["default"]["webhooks"] = {"enabled": True, "subs": {}}
    r = lossy.post(W, json=GOOD)
    assert r.status_code == 502 and "whsec" not in r.text


def test_dropped_toggle_and_delete_are_not_success(lossy):
    sub = {"description": "", "events": [], "prompt": "", "skills": [], "deliver": "log", "secret": "x"}
    lossy.dash.state.profiles["default"]["webhooks"] = {"enabled": True, "subs": {"github-push": sub}}
    assert lossy.put(f"{W}/github-push/enabled", json={"enabled": False}).status_code == 502
    assert lossy.request("DELETE", f"{W}/github-push", params={"confirm": "github-push"}).status_code == 502
