import json

import httpx
import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request

from app.audit import AuditLog
from app.main import create_app
from app.security import client_ip
from devtools.mock_hermes import create_mock
from tests.conftest import BASE, RouterTransport


def test_csrf_header_required(client):
    r = client.post(f"{BASE}/runs", json={"text": "x"}, headers={"X-Requested-With": ""})
    assert r.status_code == 403


def test_foreign_origin_rejected(client):
    r = client.post(f"{BASE}/runs", json={"text": "x"}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403


def test_security_headers(client):
    h = client.get("/healthz").headers
    assert "default-src 'self'" in h["content-security-policy"] and "unsafe-inline" not in h["content-security-policy"]
    assert h["x-frame-options"] == "DENY" and h["x-content-type-options"] == "nosniff"
    assert client.get("/bff/hosts").headers["cache-control"] == "no-store"
    assert "strict-transport-security" not in h  # nur in prod


def test_hsts_in_prod(make_settings):
    app = create_app(make_settings(env="prod", auth_mode="oidc", oidc_issuer="https://i.test", oidc_client_id="a",
                                   oidc_client_secret="b", oidc_allowed_sub="1", public_url="https://x.test",
                                   allowed_hosts="x.test"))
    with TestClient(app, base_url="https://x.test") as c:
        assert "max-age=" in c.get("/healthz").headers["strict-transport-security"]


def test_bad_host_rejected(client):
    assert client.get("/healthz", headers={"Host": "evil.example"}).status_code == 400


def test_body_limit(client):
    r = client.post(f"{BASE}/runs", content=b"x" * 10, headers={"Content-Length": str(5_000_000), "Content-Type": "application/json"})
    assert r.status_code == 413


def test_rate_limit(make_settings):
    app = create_app(make_settings(runs_per_minute=2),
                     transport=RouterTransport({"hermes.test": httpx.ASGITransport(app=create_mock(False, 0))}))
    with TestClient(app) as c:
        c.headers["X-Requested-With"] = "hermes-webui"
        codes = [c.post(f"{BASE}/runs", json={"text": "x"}).status_code for _ in range(3)]
        other = c.post("/bff/h/server/hermes/beta/runs", json={"text": "x"}).status_code
    assert codes == [202, 202, 429] and other == 202  # Limit gilt je Agent


# --- Audit-Log ------------------------------------------------------------------------------------
def test_audit_log_records_actions_without_content(client, tmp_path):
    secret_prompt = "mein-geheimer-prompt-123"
    info = client.post(f"{BASE}/runs", json={"text": secret_prompt, "model": "mock-large"}).json()
    client.post(f"{BASE}/runs/{info['run_id']}/stop")
    client.post(f"{BASE}/runs/{info['run_id']}/approval", json={"decision": "deny"})
    raw = (tmp_path / "audit.log").read_text()
    lines = [json.loads(l) for l in raw.splitlines()]
    assert [l["action"] for l in lines] == ["run.start", "run.stop"]  # Freigabe scheiterte (409) und steht nicht drin
    start = lines[0]
    assert start["user"] == "dev" and start["target"] == "server/hermes/default" and start["detail"]["chars"] == len(secret_prompt)
    assert start["detail"]["run"] == info["run_id"] and start["ts"].endswith("Z")
    assert secret_prompt not in raw and "dev-key" not in raw


def test_audit_log_file_is_private_and_failures_do_not_raise(tmp_path):
    path = tmp_path / "a.log"
    AuditLog(path).record("x", user="u", note="y" * 1000)
    assert oct(path.stat().st_mode & 0o777) == "0o600"
    assert len(json.loads(path.read_text())["detail"]["note"]) == 200
    AuditLog(tmp_path / "gibt" / "es" / "nicht" / "a.log").record("x")  # kein Fehler nach außen


# --- Client-Adresse -------------------------------------------------------------------------------------
def request_from(peer, xff=None):
    headers = [(b"x-forwarded-for", xff.encode())] if xff else []
    return Request({"type": "http", "headers": headers, "client": (peer, 1234), "method": "GET", "path": "/"})


def test_forwarded_for_only_from_trusted_proxy(make_settings):
    s = make_settings()
    assert client_ip(request_from("127.0.0.1", "1.1.1.1, 203.0.113.9"), s) == "203.0.113.9"
    assert client_ip(request_from("198.51.100.7", "1.1.1.1"), s) == "198.51.100.7"  # nicht vertraut: Header ignoriert
    assert client_ip(request_from("127.0.0.1"), s) == "127.0.0.1"


# --- Auslieferung des Frontends -------------------------------------------------------------------
@pytest.fixture
def static_client(make_settings, tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>Hermes</title>")
    (dist / "assets" / "app.js").write_text("console.log(1)")
    (tmp_path / "geheim.txt").write_text("nicht ausliefern")
    app = create_app(make_settings(static_dir=dist))
    with TestClient(app) as c:
        yield c


def test_spa_routes_fall_back_to_index(static_client):
    for path in ("/", "/inbox", "/hosts", "/h/server/hermes/gamma/chat/abc"):
        r = static_client.get(path)
        assert r.status_code == 200 and "<title>Hermes</title>" in r.text and r.headers["cache-control"] == "no-cache"
    assert static_client.get("/assets/app.js").status_code == 200


def test_spa_does_not_shadow_api_or_leak_files(static_client):
    assert static_client.get("/bff/gibt-es-nicht").status_code == 404
    assert static_client.get("/auth/gibt-es-nicht").status_code == 404
    r = static_client.get("/..%2fgeheim.txt")
    assert "nicht ausliefern" not in r.text


def test_old_service_worker_gets_replaced_by_a_self_removing_one(static_client):
    r = static_client.get("/sw.js")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/javascript")
    assert r.headers["cache-control"] == "no-cache"
    # kein fetch-Handler (Anfragen gehen am Worker vorbei), räumt auf und meldet sich ab
    assert "unregister()" in r.text and "caches.delete" in r.text and '"fetch"' not in r.text
