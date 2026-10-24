import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from devtools.mock_dashboard import create_mock as create_dashboard
from devtools.mock_hermes import API_KEY, create_mock

HDR = {"X-Requested-With": "hermes-webui"}
BASE = "/bff/h/server/hermes/default"


class RouterTransport(httpx.AsyncBaseTransport):
    """Leitet nach Hostname an eine ASGI-App; unbekannte Hosts sind nicht erreichbar."""

    def __init__(self, routes: dict[str, httpx.AsyncBaseTransport]):
        self.routes = routes

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        transport = self.routes.get(request.url.host)
        if transport is None:
            raise httpx.ConnectError("kein Ziel", request=request)
        return await transport.handle_async_request(request)


def hosts_config(key: str = API_KEY) -> dict:
    return {"hosts": [
        {"id": "server", "label": "Server", "kind": "local", "runtimes": [
            {"id": "hermes", "base_url": "http://hermes.test", "api_key": key, "multiplex": True, "dashboard": {"base_url": "http://dashboard.test"},
             "agents": ["default", "beta", "ghost", "../evil", {"id": "eta", "label": "Eta"}]}]},
        {"id": "keyless", "label": "Falscher Key", "kind": "local", "runtimes": [
            {"id": "hermes", "base_url": "http://hermes.test", "api_key": "wrong", "multiplex": True, "agents": ["default"]}]},
        {"id": "down", "label": "Aus", "kind": "local", "runtimes": [
            {"id": "hermes", "base_url": "http://down.test", "api_key": key, "multiplex": True, "agents": ["default"]}]},
        {"id": "laptop", "label": "Laptop", "kind": "remote", "address": "100.64.3.4", "runtimes": [
            {"id": "hermes", "base_url": "http://laptop.test:8642", "api_key": key, "multiplex": False, "agents": ["default"]}]},
    ]}


@pytest.fixture
def hosts_file(tmp_path):
    f = tmp_path / "hosts.json"
    f.write_text(json.dumps(hosts_config()))
    return f


@pytest.fixture
def make_settings(hosts_file, tmp_path):
    def make(**kw):
        base = dict(env="dev", hosts_file=hosts_file, audit_file=tmp_path / "audit.log", runs_per_minute=1000, health_ttl_s=0,
                    soul_dir=tmp_path / "soul-history")
        return Settings(**{**base, **kw})
    return make


@pytest.fixture
def mock():
    return create_mock(wait_for_user=False, delay=0, profiles=("default", "beta", "eta"))


@pytest.fixture
def client(make_settings, mock):
    app = create_app(make_settings(), transport=RouterTransport({"hermes.test": httpx.ASGITransport(app=mock)}))
    with TestClient(app) as c:
        c.headers.update(HDR)
        yield c
