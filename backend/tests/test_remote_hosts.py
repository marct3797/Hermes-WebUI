"""Hosts im Tailnet (kind "remote") laufen über denselben Adapter wie lokale: Config genügt, kein Sonderweg."""
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.registry import parse_config
from devtools.mock_hermes import API_KEY, create_mock
from tests.conftest import HDR, RouterTransport, hosts_config
from tests.test_api import events_of

LAPTOP = "/bff/h/laptop/hermes/default"


@pytest.fixture
def laptop_up(make_settings):
    """Der Laptop-Dienst antwortet: ein Hermes ohne Profil-Präfix (multiplex: false), wie `hermes gateway` auf einem Einzelrechner."""
    routes = {
        "hermes.test": httpx.ASGITransport(app=create_mock(delay=0, profiles=("default", "omoikane", "sora"))),
        "laptop.test": httpx.ASGITransport(app=create_mock(delay=0, multiplex=False, profiles=("default",))),
    }
    with TestClient(create_app(make_settings(), transport=RouterTransport(routes))) as c:
        c.headers.update(HDR)
        yield c


def test_remote_host_is_online_when_its_hermes_answers(laptop_up):
    laptop = next(h for h in laptop_up.get("/bff/hosts").json()["hosts"] if h["id"] == "laptop")
    assert laptop["status"] == "online" and laptop["kind"] == "remote" and laptop["address"] == "100.100.3.4"
    rt = laptop["runtimes"][0]
    assert rt["status"] == "online" and rt["version"] and rt["detail"] is None
    st = laptop_up.get(f"{LAPTOP}/status").json()
    assert st["state"] == "online" and "runs" in st["features"]


def test_remote_host_runs_a_chat_end_to_end(laptop_up):
    r = laptop_up.post(f"{LAPTOP}/runs", json={"text": "Hallo vom Laptop"})
    assert r.status_code == 202, r.text
    info = r.json()
    types = [e["type"] for e in events_of(laptop_up, info, base=LAPTOP)]
    assert types[0] == "run.started" and types[-1] == "run.completed"
    # Die Sitzung steht in der Liste des Laptops, nicht in der von Hikari.
    assert info["session_id"] in json.dumps(laptop_up.get(f"{LAPTOP}/sessions").json())
    assert info["session_id"] not in json.dumps(laptop_up.get("/bff/h/hikari/hermes/default/sessions").json())


def test_remote_host_sends_its_own_key_and_reports_a_wrong_one(make_settings, tmp_path):
    cfg = hosts_config()
    cfg["hosts"][3]["runtimes"][0]["api_key"] = "falsch"
    f = tmp_path / "wrong.json"
    f.write_text(json.dumps(cfg))
    routes = {"laptop.test": httpx.ASGITransport(app=create_mock(delay=0, multiplex=False, profiles=("default",)))}
    with TestClient(create_app(make_settings(hosts_file=f), transport=RouterTransport(routes))) as c:
        c.headers.update(HDR)
        st = c.get(f"{LAPTOP}/status").json()
        assert st["state"] == "auth_error" and st["online"] is False
        assert "falsch" not in json.dumps(c.get("/bff/hosts").json()) and API_KEY not in c.get("/bff/hosts").text


def test_remote_host_that_is_off_names_address_and_hint(client):
    laptop = next(h for h in client.get("/bff/hosts").json()["hosts"] if h["id"] == "laptop")
    assert laptop["status"] == "unreachable"
    assert "laptop.test:8642" in laptop["detail"] and "lauscht" in laptop["detail"]
    st = client.get(f"{LAPTOP}/status").json()
    assert st["state"] == "unreachable" and "laptop.test:8642" in st["error"]


def test_timeout_is_reported_as_such(make_settings):
    class Slow(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request):
            raise httpx.ConnectTimeout("zu langsam", request=request)

    with TestClient(create_app(make_settings(), transport=RouterTransport({"laptop.test": Slow()}))) as c:
        c.headers.update(HDR)
        err = c.get(f"{LAPTOP}/status").json()["error"]
        assert "nicht rechtzeitig" in err and "laptop.test:8642" in err


def test_remote_key_comes_from_the_environment():
    raw = {"hosts": [{"id": "laptop", "label": "Laptop", "kind": "remote", "address": "100.100.3.4", "runtimes": [
        {"id": "hermes", "base_url": "http://100.100.3.4:8642", "api_key_env": "HERMES_KEY_LAPTOP", "multiplex": False, "agents": ["default"]}]}]}
    rt = parse_config(raw, {"HERMES_KEY_LAPTOP": "geheim"})["laptop"].runtimes[0]
    assert rt.api_key == "geheim" and rt.base_url == "http://100.100.3.4:8642"
    assert "geheim" not in repr(rt)
