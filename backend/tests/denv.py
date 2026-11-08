"""Gemeinsamer Aufbau für Tests der Dashboard-Routen: echtes BFF, Mock-Dashboard, angemeldeter Nutzer mit frischer Anmeldung."""
import json

import httpx
from fastapi.testclient import TestClient

from app.auth import SESSION_COOKIE, User
from app.main import create_app
from devtools.mock_dashboard import create_mock as create_dashboard
from devtools.mock_hermes import create_mock
from tests.conftest import BASE, HDR, RouterTransport  # noqa: F401  (BASE und HDR gibt der Test weiter)


def client(tmp_path, make_settings, drop_writes=False):
    f = tmp_path / "d-hosts.json"
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


def stale(c):
    c.app.state.sessions.get(c.cookies.get(SESSION_COOKIE)).auth_time = 0


def fresh(c):
    c.app.state.sessions.get(c.cookies.get(SESSION_COOKIE)).auth_time = c.app.state.sessions.now()
