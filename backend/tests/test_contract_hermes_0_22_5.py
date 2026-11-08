"""Lese-Routen des BFF gegen echte Antworten von Hermes 0.22.5 (tests/fixtures/real/hermes_0_22_5_dashboard.json).

Die Datei stammt aus einem Dashboard mit frischem Sandbox-HOME (devtools/real/contract_config.py beschreibt den Aufbau). Ein Wiedergabe-Dashboard
liefert genau diese Antworten; schlägt ein Test fehl, hat sich eine Form geändert oder der Adapter verlässt sich auf etwas, das Hermes nicht liefert.
"""
import json
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from app.main import create_app
from devtools.mock_hermes import create_mock
from tests.conftest import HDR, RouterTransport

REC = json.loads((Path(__file__).parent / "fixtures/real/hermes_0_22_5_dashboard.json").read_text())["routes"]


def replay() -> FastAPI:
    app = FastAPI()

    @app.api_route("/{path:path}", methods=["GET"])
    async def get(path: str, request: Request):
        hit = REC.get("/" + path)
        return JSONResponse(hit["body"], status_code=hit["status"]) if hit else JSONResponse({"detail": "nicht aufgenommen"}, status_code=404)

    return app


@pytest.fixture
def c(tmp_path, make_settings):
    f = tmp_path / "hosts.json"
    rt = {"id": "hermes", "base_url": "http://hermes.test", "api_key": "k" * 16, "multiplex": True, "agents": ["default"], "dashboard": {"base_url": "http://dash.test"}}
    f.write_text(json.dumps({"hosts": [{"id": "h", "runtimes": [rt]}]}))
    app = create_app(make_settings(hosts_file=f), transport=RouterTransport({"hermes.test": httpx.ASGITransport(app=create_mock(delay=0)), "dash.test": httpx.ASGITransport(app=replay())}))
    with TestClient(app) as client:
        client.headers.update(HDR)
        yield client


A = "/bff/h/h/hermes/default"


def test_profile_status_and_soul(c):
    s = c.get(f"{A}/dashboard").json()
    assert s["available"] is True and s["profile"] is not None and s["profile"]["name"] == "default"
    soul = c.get(f"{A}/soul").json()
    assert "content" in soul and soul["max_chars"] > 0


def test_settings_have_the_fields_the_schema_describes(c):
    body = c.get(f"{A}/config").json()
    assert len(body["fields"]) == 60 and body["category_order"]
    assert all(f["type"] in {"string", "text", "number", "boolean", "select", "list"} for f in body["fields"])
    assert not [f for f in body["fields"] if f.get("secret") and f.get("value") is not None]


def test_provider_overview_reads_the_real_env_catalog_and_oauth_list(c):
    r = c.get(f"{A}/providers")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["providers"] and all({"id", "keys"} <= set(p) for p in body["providers"])
    assert any(p["keys"] for p in body["providers"])  # der echte Katalog enthält Anbieter-Keys


def test_model_options_empty_without_login_is_not_an_error(c):
    r = c.get(f"{A}/providers/models")
    assert r.status_code == 200 and r.json()["providers"] == []


def test_skills_mcp_and_plugin_lists_parse_real_shapes(c):
    skills = c.get("/bff/h/h/_ext/default/skill-list").json()["skills"]
    assert skills and all(isinstance(s["name"], str) for s in skills)
    assert c.get("/bff/h/h/_ext/default/mcp").json()["servers"] == []
    assert c.get("/bff/h/h/_ext/default/plugins").status_code == 200
    assert c.get("/bff/h/h/_ext/default/mcp/catalog").status_code == 200
    assert c.get("/bff/h/h/_ext/default/plugins/catalog").status_code == 200


def test_cron_lists_parse_real_shapes(c):
    assert c.get("/bff/h/h/_cron/default/schedules").json()["jobs"] == []
    assert c.get("/bff/h/h/_cron/default/targets").status_code == 200
    bp = c.get("/bff/h/h/_cron/default/blueprints")
    assert bp.status_code == 200 and bp.json()["blueprints"]


def test_kanban_board_has_all_eight_columns_in_order(c):
    cols = c.get("/bff/h/h/_kanban/board").json()
    names = [x["name"] for x in cols.get("columns", [])]
    assert names == ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done"]


def test_quota_without_the_plugin_says_so_instead_of_failing(c):
    r = c.get(f"{A}/quota")
    assert r.status_code == 200 and r.json().get("state") in {"plugin_missing", "unavailable"} or r.json().get("providers") is not None
