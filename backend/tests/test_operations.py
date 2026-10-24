"""Operations integration: fake daemon/HTTP and real cookie authentication, no models."""
import json

import pytest

from app.registry import ConfigError, parse_config

import base64
import socket
import threading
import time

import httpx
import uvicorn
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.auth import SESSION_COOKIE, User
from app.main import create_app
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location("mock_hostd_fixture", Path(__file__).parents[2] / "devtools/mock_hostd.py")
assert _spec is not None and _spec.loader is not None
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
TOKEN, create_mock = _module.TOKEN, _module.create_mock

BASE = "/bff/h/box"
HDR = {"X-Requested-With": "hermes-webui"}


@pytest.fixture
def operations_client(tmp_path, make_settings, monkeypatch):
    from app.routes.operations import router
    monkeypatch.setenv("TEST_HOSTD", TOKEN)
    f = tmp_path / "ops-hosts.json"
    f.write_text(json.dumps({"hosts": [
        {"id": "box", "hostd": {"base_url": "http://daemon.test", "token_env": "TEST_HOSTD"},
         "runtimes": [{"id": "hermes", "base_url": "http://daemon.test", "api_key": TOKEN,
                       "multiplex": True, "agents": ["default"]}]},
        {"id": "unconfigured"},
        {"id": "offline", "hostd": {"base_url": "http://offline.test", "token_env": "TEST_HOSTD"}},
    ]}))
    daemon = create_mock()
    from conftest import RouterTransport
    transport = RouterTransport({"daemon.test": httpx.ASGITransport(app=daemon)})
    settings = make_settings(hosts_file=f, auth_mode="oidc", oidc_issuer="https://id.test",
        oidc_client_id="test", oidc_client_secret="test", oidc_allowed_sub="user",
        public_url="http://testserver")
    app = create_app(settings, transport=transport)
    if "/bff/h/{host}/_hostd" not in app.openapi()["paths"]:
        previous = list(app.router.routes)
        app.include_router(router)
        added = app.router.routes[len(previous):]
        app.router.routes[:] = added + previous  # reserved paths before dynamic agent routes
    with TestClient(app) as client:
        session = app.state.sessions.create(User("user", "Test"))
        session.auth_time = app.state.sessions.now()
        client.cookies.set(SESSION_COOKIE, session.id)
        client.headers.update(HDR)
        yield client, daemon, app, session


def test_host_info_real_data_and_explicit_unavailable(operations_client):
    c, daemon, app, session = operations_client
    info = c.get(BASE + "/_hostd").json()
    assert info["available"] is True
    assert info["clis"][0]["authenticated"] is None
    assert TOKEN not in json.dumps(info)
    assert c.get("/bff/h/unconfigured/_hostd").json()["available"] is False
    assert c.get("/bff/h/offline/_hostd").json()["available"] is False
    assert c.get("/bff/h/unknown/_hostd").status_code == 404
    c.cookies.clear()
    assert c.get(BASE + "/_hostd").status_code == 401


def test_terminal_lifecycle_and_server_only_bearer(operations_client):
    c, daemon, app, session = operations_client
    assert c.get(BASE + "/_terminals").json() == {"terminals": []}
    terminal = c.post(BASE + "/_terminals", json={"cli": "codex", "workspace": "repo"}).json()
    assert terminal["id"] == "term-1"
    assert c.get(BASE + "/_terminals").json()["terminals"][0]["running"]
    assert c.delete(BASE + "/_terminals/term-1").status_code == 200
    assert daemon.state.terminals["term-1"]["running"] is False
    for call in daemon.state.calls:
        assert call["headers"]["authorization"] == f"Bearer {TOKEN}"
        assert "cookie" not in call["headers"]
        assert TOKEN not in call["query"]
    text = app.state.settings.audit_file.read_text()
    assert TOKEN not in text
    assert '"cli"' not in text  # audit only action/target, no free input


@pytest.mark.parametrize("suffix,method,body", [
    ("/_terminals", "post", {"cli": "codex", "workspace": "repo"}),
    ("/_terminals/term-1", "delete", None),
    ("/_files/upload", "post", {"workspace": "repo", "path": "new.txt", "content_base64": "eA=="}),
    ("/_manage/default/plugins/disable", "post", {"id": "example"}),
    ("/hermes/default/jobs", "post", {"name": "test", "schedule": "0 1 * * *"}),
])
def test_writes_require_fresh_auth_before_upstream(operations_client, suffix, method, body):
    c, daemon, app, session = operations_client
    session.auth_time -= app.state.settings.step_up_s + 1
    response = c.request(method, BASE + suffix, **({"json": body} if body is not None else {}))
    assert response.status_code == 401
    assert not daemon.state.calls


@pytest.mark.parametrize("body", [
    {"cli": "../shell", "workspace": "repo"},
    {"cli": "codex", "workspace": "repo", "command": "sh"},
    {"cli": "codex", "workspace": "repo", "cols": 0},
    {"cli": "codex", "workspace": "repo", "rows": 10000},
])
def test_terminal_validation(operations_client, body):
    c, daemon, *_ = operations_client
    assert c.post(BASE + "/_terminals", json=body).status_code == 422
    assert not daemon.state.calls


def test_workspace_download_and_upload(operations_client):
    c, daemon, app, session = operations_client
    assert c.get(BASE + "/_workspaces").json()["workspaces"][0]["id"] == "repo"
    assert c.get(BASE + "/_files", params={"workspace": "repo", "path": "README.md"}).json()["content"].startswith("fake")
    download = c.get(BASE + "/_files/download", params={"workspace": "repo", "path": "report.pdf"})
    assert download.content.startswith(b"%PDF")
    assert download.headers["content-disposition"].startswith("attachment;")
    assert download.headers["content-type"] == "application/octet-stream"
    assert "set-cookie" not in download.headers and "x-untrusted" not in download.headers
    data = {"workspace": "repo", "path": "new.pdf", "content_base64": "JVBERg=="}
    assert c.post(BASE + "/_files/upload", json=data).status_code == 200
    assert daemon.state.files["new.pdf"] == b"%PDF"
    assert c.post(BASE + "/_files/upload", json=data).status_code == 409
    assert c.get(BASE + "/_git", params={"workspace": "repo"}).json()["branch"] == "main"
    assert "%PDF" not in app.state.settings.audit_file.read_text()


@pytest.mark.parametrize("path", ["../x", "/etc/passwd", "a/../../x", "a\\x", ".env", "foo/.git/config", "auth.json", "a/%2e%2e/x"])
def test_unsafe_paths_never_forwarded(operations_client, path):
    c, daemon, *_ = operations_client
    assert c.get(BASE + "/_files", params={"workspace": "repo", "path": path}).status_code == 422
    assert not daemon.state.calls


def test_upload_limits_and_base64(operations_client):
    c, daemon, *_ = operations_client
    for content in ("invalid!", base64.b64encode(b"x" * (1048576 + 1)).decode()):
        assert c.post(BASE + "/_files/upload", json={"workspace": "repo", "path": "new.bin",
                     "content_base64": content}).status_code in (413, 422)
    assert not daemon.state.calls


def test_global_search_aggregates_and_reports_failures(operations_client):
    c, daemon, *_ = operations_client
    result = c.get("/bff/search", params={"q": "needle"}).json()
    assert result["results"] == [{"host": "box", "profile": "default", "session_id": "session-1",
                                  "title": "Test", "snippet": "needle"}]
    assert len(result["warnings"]) == 2
    assert c.get("/bff/search", params={"q": ""}).status_code == 422


def test_management_allowlist_and_reviewed_sources(operations_client):
    c, daemon, *_ = operations_client
    daemon.state.sources = [{"id": "approved", "kind": "plugins", "url": "https://github.com/NousResearch/hermes-agent",
                             "reviewed": True, "trust": "Configured by host administrator"}]
    result = c.get(BASE + "/_manage").json()
    assert result["profiles"] == [{"id": "default"}]
    assert result["sources"] and all(s["url"].startswith("https://") for s in result["sources"])
    assert any(s["id"] == "approved" for s in result["sources"])
    for kind in ("skills", "mcp", "plugins", "logs", "kanban"):
        assert c.get(BASE + f"/_manage/default/{kind}").status_code == 200
    assert c.post(BASE + "/_manage/default/plugins/disable", json={"id": "example"}).status_code == 200
    assert daemon.state.enabled is False
    assert c.post(BASE + "/_manage/default/plugins/install", json={"id": "reviewed-plugin"}).status_code == 200
    for path, body in [("skills/install", {"url": "https://evil.invalid/repo"}),
                       ("logs/delete", {}), ("kanban/run", {}), ("mcp/exec", {"command": "sh"})]:
        assert c.post(BASE + "/_manage/default/" + path, json=body).status_code in (404, 422)


def test_jobs_http_crud_no_run_and_failures_preserved(operations_client):
    c, daemon, *_ = operations_client
    prefix = BASE + "/hermes/default/jobs"
    assert c.get(prefix).json() == {"jobs": []}
    response = c.post(prefix, json={"name": "test", "schedule": "0 1 * * *", "prompt": "test"})
    assert response.status_code == 200
    assert daemon.state.jobs["abcdef123456"]["paused"] is True
    assert c.get(prefix + "/abcdef123456").json()["job"]["name"] == "test"
    assert c.patch(prefix + "/abcdef123456", json={"name": "changed"}).status_code == 200
    assert c.post(prefix + "/abcdef123456/resume", json={}).json()["job"]["paused"] is False
    assert c.post(prefix + "/abcdef123456/pause", json={}).json()["job"]["paused"] is True
    assert c.post(prefix + "/abcdef123456/run", json={}).status_code == 404
    assert c.delete(prefix + "/abcdef123456").status_code == 200
    assert c.get(prefix + "/abcdef123456").status_code == 404
    daemon.state.jobs_admin = False
    assert c.get(prefix).status_code == 200
    assert c.post(prefix, json={"name": "x", "schedule": "0 1 * * *"}).status_code == 501
    daemon.state.fail = 409
    assert c.get(prefix).status_code == 409


@pytest.mark.parametrize("headers,cookie,fresh", [({}, True, True),
    ({"origin": "http://evil.test"}, True, True), ({"origin": "http://testserver"}, False, True),
    ({"origin": "http://testserver", "host": "evil.test"}, True, True),
    ({"origin": "http://testserver"}, True, False)])
def test_websocket_rejected_before_accept(operations_client, headers, cookie, fresh):
    c, daemon, app, session = operations_client
    if not cookie:
        c.cookies.clear()
    if not fresh:
        session.auth_time -= app.state.settings.step_up_s + 1
    with pytest.raises(WebSocketDisconnect):
        with c.websocket_connect(BASE + "/_terminals/term-1/stream", headers=headers) as ws:
            ws.receive_json()
    assert not daemon.state.calls


@pytest.fixture
def live_fake_daemon():
    daemon = create_mock()
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    server = uvicorn.Server(uvicorn.Config(daemon, log_level="critical", access_log=False))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(.02)
    assert server.started
    yield daemon, sock.getsockname()[1]
    server.should_exit = True
    thread.join(5)
    sock.close()


def test_websocket_real_proxy_and_disconnect_preserves_terminal(operations_client, live_fake_daemon):
    c, daemon, app, session = operations_client
    live, port = live_fake_daemon
    config = json.loads(app.state.settings.hosts_file.read_text())
    config["hosts"][0]["hostd"]["base_url"] = f"http://127.0.0.1:{port}"
    app.state.settings.hosts_file.write_text(json.dumps(config))
    with c.websocket_connect(BASE + "/_terminals/term-1/stream?after=5", headers={"origin": "http://testserver"}) as ws:
        assert ws.receive_json()["type"] == "output"
        ws.send_json({"type": "input", "data": "eA=="})
        assert ws.receive_json()["received"] == {"type": "input", "data": "eA=="}
        ws.send_json({"type": "resize", "cols": 90, "rows": 30})
        assert ws.receive_json()["received"]["cols"] == 90
    call = live.state.calls[0]
    assert call["method"] == "WS" and call["query"] == "after=5"
    assert call["headers"]["authorization"] == f"Bearer {TOKEN}"
    assert "cookie" not in call["headers"] and TOKEN not in call["query"]
    assert not any(x["method"] == "DELETE" for x in live.state.calls)
    assert "test output" not in app.state.settings.audit_file.read_text()


@pytest.mark.parametrize("suffix", ["/_terminals", "/_workspaces", "/_files?workspace=repo",
    "/_files/download?workspace=repo&path=README.md", "/_git?workspace=repo", "/_manage",
    "/_manage/default/logs", "/hermes/default/jobs"])
def test_all_http_reads_require_auth(operations_client, suffix):
    c, daemon, *_ = operations_client
    c.cookies.clear()
    assert c.get(BASE + suffix).status_code == 401
    assert not daemon.state.calls


@pytest.mark.asyncio
async def test_hostd_transport_limits_redirects_and_credentials():
    from app.operations import HostdClient, JSON_LIMIT, DOWNLOAD_LIMIT
    from app.registry import HostdCfg
    from fastapi import HTTPException
    async def handler(request):
        if request.url.path == "/reflect":
            return httpx.Response(200, json={"nested": [TOKEN]})
        if request.url.path == "/large":
            return httpx.Response(200, content=b"x" * (JSON_LIMIT + 1))
        if request.url.path == "/download":
            return httpx.Response(200, content=b"x" * (DOWNLOAD_LIMIT + 1))
        return httpx.Response(302, headers={"Location": "http://evil.invalid/?token=" + TOKEN})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = HostdClient(HostdCfg("http://daemon.test", TOKEN), http)
        assert await client.request("GET", "/reflect") == {"nested": ["[redacted]"]}
        for path in ("/large", "/redirect", "/download"):
            with pytest.raises(HTTPException) as err:
                await client.request("GET", path, download=path == "/download")
            assert err.value.status_code == 502
            assert TOKEN not in str(err.value.detail)


def test_hostd_config_is_optional_and_secret_repr_hidden():
    assert parse_config({"hosts": [{"id": "old"}]})["old"].hostd is None
    cfg = parse_config({"hosts": [{"id": "box", "hostd": {
        "base_url": "http://127.0.0.1:8765/", "token_env": "TEST_HOSTD",
    }}]}, {"TEST_HOSTD": TOKEN})["box"].hostd
    assert cfg.base_url == "http://127.0.0.1:8765"
    assert cfg.token == TOKEN
    assert TOKEN not in repr(cfg)


@pytest.mark.parametrize("value", [None, [], {}, {"base_url": "file:///tmp"},
    {"base_url": "http://user:pass@host", "token_env": "KEY"},
    {"base_url": "http://host?token=x", "token_env": "KEY"},
    {"base_url": "http://host/path", "token_env": "KEY"},
    {"base_url": "http://host", "token_env": "bad-name"},
    {"base_url": "http://host", "token_env": "KEY", "token": TOKEN}])
def test_invalid_hostd_config_rejected(value):
    with pytest.raises(ConfigError):
        parse_config({"hosts": [{"id": "box", "hostd": value}]}, {"KEY": TOKEN})


def test_missing_short_or_header_injection_token_rejected():
    for token in ("", "short", TOKEN + "\r\nx: y"):
        with pytest.raises(ConfigError):
            parse_config({"hosts": [{"id": "box", "hostd": {
                "base_url": "http://localhost", "token_env": "KEY",
            }}]}, {"KEY": token})


@pytest.mark.parametrize("path", ["....//....//etc/passwd", "...", "a//b", ".%2e", "..;/", "a/./b", "a/", "a/..b"])
def test_dotty_paths_are_422_everywhere(operations_client, path):
    c, daemon, *_ = operations_client
    base = "/bff/h/box"
    assert c.get(base + "/_files", params={"workspace": "repo", "path": path}).status_code == 422
    assert c.get(base + "/_files/download", params={"workspace": "repo", "path": path}).status_code == 422
    assert c.post(base + "/_files/upload", json={"workspace": "repo", "path": path, "content_base64": "eA=="}).status_code == 422
    assert not daemon.state.calls


def test_root_and_normal_paths_still_allowed(operations_client):
    c, *_ = operations_client
    assert c.get("/bff/h/box/_files", params={"workspace": "repo", "path": ""}).status_code == 200
    assert c.get("/bff/h/box/_files", params={"workspace": "repo", "path": "README.md"}).status_code == 200


def test_cli_auth_routes(operations_client):
    c, daemon, app, session = operations_client
    got = c.get(BASE + "/_cli-auth").json()
    assert got["available"] is True and got["clis"][0] == {
        "id": "codex", "state": "signed_in", "method": "ChatGPT", "checked_at": "2026-01-01T00:00:00+00:00", "reason": None}
    assert not any("refresh" in x["query"] for x in daemon.state.calls if x["path"] == "/v1/auth")
    assert c.post(BASE + "/_cli-auth/refresh").json()["available"] is True
    assert any(x["query"] == "refresh=1" for x in daemon.state.calls if x["path"] == "/v1/auth")
    assert c.get("/bff/h/unconfigured/_cli-auth").json() == {"available": False, "reason": "Host-Dienst nicht eingerichtet"}
    assert c.get("/bff/h/offline/_cli-auth").json()["available"] is False
    assert c.get("/bff/h/unknown/_cli-auth").status_code == 404
    assert TOKEN not in json.dumps(got)
    assert c.post(BASE + "/_cli-auth/refresh", headers={"X-Requested-With": ""}).status_code in (400, 403)
    c.cookies.clear()
    assert c.get(BASE + "/_cli-auth").status_code == 401
    assert c.post(BASE + "/_cli-auth/refresh").status_code in (401, 403)


def test_file_edit_mkdir_move_roundtrip_and_audit_without_content(operations_client):
    c, daemon, app, session = operations_client
    listing = c.get(BASE + "/_files", params={"workspace": "repo"}).json()["entries"]
    assert {(e["name"], e["kind"]) for e in listing} >= {("src", "directory"), ("README.md", "file")}
    read = c.get(BASE + "/_files", params={"workspace": "repo", "path": "README.md", "full": "true"}).json()
    assert read["editable"] is True and len(read["sha256"]) == 64
    assert any(call["query"].find("full=true") >= 0 for call in daemon.state.calls)
    saved = c.put(BASE + "/_files/write", json={"workspace": "repo", "path": "README.md", "content": "GEHEIMER-INHALT",
                  "expected_sha256": read["sha256"]})
    assert saved.status_code == 200 and daemon.state.files["README.md"] == b"GEHEIMER-INHALT"
    stale = c.put(BASE + "/_files/write", json={"workspace": "repo", "path": "README.md", "content": "x", "expected_sha256": read["sha256"]})
    assert stale.status_code == 409 and "geändert" in stale.json()["detail"]
    assert daemon.state.files["README.md"] == b"GEHEIMER-INHALT"
    assert c.put(BASE + "/_files/write", json={"workspace": "repo", "path": "neu.txt", "content": "", "create": True}).status_code == 200
    assert c.put(BASE + "/_files/write", json={"workspace": "repo", "path": "neu.txt", "content": "", "create": True}).status_code == 409
    assert c.post(BASE + "/_files/mkdir", json={"workspace": "repo", "path": "docs"}).status_code == 200
    assert c.post(BASE + "/_files/mkdir", json={"workspace": "repo", "path": "docs"}).status_code == 409
    moved = c.post(BASE + "/_files/move", json={"workspace": "repo", "from": "neu.txt", "to": "docs-neu.txt"})
    assert moved.status_code == 200 and "docs-neu.txt" in daemon.state.files and "neu.txt" not in daemon.state.files
    assert c.post(BASE + "/_files/move", json={"workspace": "repo", "from": "nix.txt", "to": "y.txt"}).status_code == 404
    audit = app.state.settings.audit_file.read_text()
    for action in ("workspace.write", "workspace.mkdir", "workspace.move"):
        assert action in audit
    assert "GEHEIMER-INHALT" not in audit and "README.md" not in audit and "path_len" in audit


@pytest.mark.parametrize("method,suffix,body", [
    ("post", "/_files/mkdir", {"workspace": "repo", "path": "../x"}),
    ("post", "/_files/mkdir", {"workspace": "repo", "path": ".git"}),
    ("put", "/_files/write", {"workspace": "repo", "path": "/etc/x", "content": "x"}),
    ("put", "/_files/write", {"workspace": "repo", "path": ".env", "content": "x", "create": True}),
    ("put", "/_files/write", {"workspace": "repo", "path": "a", "content": "x", "expected_sha256": "nope"}),
    ("put", "/_files/write", {"workspace": "repo", "path": "a", "content": "x" * 1048577}),
    ("put", "/_files/write", {"workspace": "repo", "path": "a", "content": "x", "extra": 1}),
    ("post", "/_files/move", {"workspace": "repo", "from": "a", "to": "../b"}),
    ("post", "/_files/move", {"workspace": "repo", "from": "a/../c", "to": "b"}),
    ("post", "/_files/move", {"workspace": "repo", "source": "a", "to": "b"}),
])
def test_file_writes_validate_before_upstream(operations_client, method, suffix, body):
    c, daemon, *_ = operations_client
    assert getattr(c, method)(BASE + suffix, json=body).status_code == 422
    assert not daemon.state.calls


@pytest.mark.parametrize("method,suffix,body", [
    ("post", "/_files/mkdir", {"workspace": "repo", "path": "d"}),
    ("put", "/_files/write", {"workspace": "repo", "path": "a.txt", "content": "x", "create": True}),
    ("post", "/_files/move", {"workspace": "repo", "from": "a", "to": "b"}),
])
def test_file_writes_need_fresh_auth_and_login(operations_client, method, suffix, body):
    c, daemon, app, session = operations_client
    session.auth_time -= app.state.settings.step_up_s + 1
    assert getattr(c, method)(BASE + suffix, json=body).status_code == 401
    c.cookies.clear()
    assert getattr(c, method)(BASE + suffix, json=body).status_code == 401
    assert not daemon.state.calls


def test_git_details_and_hostd_error_texts(operations_client):
    c, daemon, *_ = operations_client
    git = c.get(BASE + "/_git", params={"workspace": "repo"}).json()
    assert git["files"] == [{"path": "README.md", "state": "M"}] and git["log"][0]["subject"] == "Erster Stand"
    assert git["branches"] == [{"name": "main", "current": True}]
    assert c.get(BASE + "/_workspaces").json()["workspaces"][0]["is_git"] is True
    daemon.state.fail = 403  # Pfadverbot des Host-Dienstes ist kein Token-Problem
    denied = c.get(BASE + "/_files", params={"workspace": "repo", "path": "x"})
    assert denied.status_code == 403 and "freigegeben" in denied.json()["detail"]
