"""Delegation, eigene Endpunkte, lokale Modelle (Punkt 8b).

Schranken des BFF (Hermes prüft das nicht selbst):
- Schreiben braucht frische Anmeldung; Schlüssel sind write-only und stehen weder in Antworten noch im Audit,
- Endpunkt-URLs: nur http(s), keine Zugangsdaten in der URL, kein Metadaten-/Link-Local-Ziel,
- Löschen nur mit Eingabe der Endpunkt-ID, Delegations-Backend nur aus der gemeldeten Liste, Übernahme wird zurückgelesen,
- `validate` schickt den Schlüssel an eine Nutzer-URL, deshalb ebenfalls frisch + URL-Prüfung.
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

D, E, L = f"{BASE}/hermes-delegation", f"{BASE}/hermes-endpoints", f"{BASE}/hermes-local-models"
KEY = "sk-geheim-endpunkt-9876"
GOOD = {"name": "Mein Ollama", "base_url": "http://127.0.0.1:11434/v1", "model": "llama3", "api_key": KEY}


def _client(tmp_path, make_settings, drop_writes):
    f = tmp_path / "ep-hosts.json"
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
        yield c


@pytest.fixture
def env(tmp_path, make_settings):
    yield from _client(tmp_path, make_settings, False)


@pytest.fixture
def lossy(tmp_path, make_settings):  # Dashboard antwortet ok, übernimmt aber nichts
    yield from _client(tmp_path, make_settings, True)


def stale(env):
    env.app.state.sessions.get(env.cookies.get(SESSION_COOKIE)).auth_time = 0


def test_delegation_read_shows_backends_and_never_a_key(env):
    r = env.get(D)
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["configured"] in {x["name"] for x in b["backends"]} and b["profiles"]
    assert KEY not in r.text and "sk-" not in json.dumps(b["model_map"])  # nur Vorschau, nie der Schlüssel


def test_delegation_backend_needs_fresh_known_name_and_reads_back(env):
    stale(env)
    assert env.put(f"{D}/backend", json={"backend": "default"}).status_code == 401
    env.app.state.sessions.get(env.cookies.get(SESSION_COOKIE)).auth_time = env.app.state.sessions.now()
    assert env.put(f"{D}/backend", json={"backend": "gibt-es-nicht"}).status_code == 422
    r = env.put(f"{D}/backend", json={"backend": "docker"})
    assert r.status_code == 200 and env.get(D).json()["configured"] == "docker"


def test_endpoint_list_exposes_only_key_presence(env):
    env.post(E, json=GOOD)
    r = env.get(E)
    row = next(x for x in r.json()["endpoints"] if x["name"] == "Mein Ollama")
    assert row["has_api_key"] is True and KEY not in r.text


@pytest.mark.parametrize("url", ["file:///etc/passwd", "ftp://x/v1", "http://user:pw@example.com/v1", "http://169.254.169.254/latest", "not a url", ""])
def test_endpoint_rejects_dangerous_urls(env, url):
    r = env.post(E, json={**GOOD, "base_url": url})
    assert r.status_code == 422, (url, r.text)
    assert env.get(E).json()["endpoints"] == []  # nichts geschrieben


def test_endpoint_create_needs_fresh_reads_back_and_audits_without_key(env):
    stale(env)
    assert env.post(E, json=GOOD).status_code == 401
    env.app.state.sessions.get(env.cookies.get(SESSION_COOKIE)).auth_time = env.app.state.sessions.now()
    r = env.post(E, json=GOOD)
    assert r.status_code == 200 and r.json()["id"] and KEY not in r.text
    assert any(x["id"] == r.json()["id"] for x in env.get(E).json()["endpoints"])
    assert KEY not in env.audit_file.read_text()


def test_activate_unknown_404_and_known_becomes_current(env):
    assert env.post(f"{E}/nope/activate").status_code == 404
    eid = env.post(E, json=GOOD).json()["id"]
    assert env.post(f"{E}/{eid}/activate").status_code == 200
    assert next(x for x in env.get(E).json()["endpoints"] if x["id"] == eid)["is_current"] is True


def test_delete_needs_typed_id(env):
    eid = env.post(E, json=GOOD).json()["id"]
    assert env.request("DELETE", f"{E}/{eid}", params={"confirm": "falsch"}).status_code == 422
    assert env.request("DELETE", f"{E}/{eid}").status_code == 422
    assert any(x["id"] == eid for x in env.get(E).json()["endpoints"])
    assert env.request("DELETE", f"{E}/{eid}", params={"confirm": eid}).status_code == 200
    assert all(x["id"] != eid for x in env.get(E).json()["endpoints"])


def test_validate_needs_fresh_and_safe_url_and_never_echoes_key(env):
    stale(env)
    assert env.post(f"{E}/validate", json=GOOD).status_code == 401
    env.app.state.sessions.get(env.cookies.get(SESSION_COOKIE)).auth_time = env.app.state.sessions.now()
    assert env.post(f"{E}/validate", json={**GOOD, "base_url": "http://169.254.169.254/"}).status_code == 422
    r = env.post(f"{E}/validate", json=GOOD)
    assert r.status_code == 200 and "ok" in r.json() and KEY not in r.text


def test_local_models_status_is_read_only_and_checked(env):
    r = env.get(f"{L}/status")
    assert r.status_code == 200 and isinstance(r.json()["models"], list) and "server_running" in r.json()
    assert env.post(f"{L}/download", json={}).status_code in (404, 405)  # Installieren/Laden bleibt CLI


def test_save_and_activate_fail_loudly_when_dashboard_drops_the_write(lossy):
    assert lossy.post(E, json=GOOD).status_code == 502  # ok-Antwort ohne Übernahme ist kein Erfolg
    lossy.dash.state.profiles["default"]["endpoints"] = {"x": {"name": "x", "base_url": "http://h/v1", "model": "m", "api_key": None}}
    assert lossy.post(f"{E}/x/activate").status_code == 502  # nicht aktiv geworden
