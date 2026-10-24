"""Regression coverage for audit F02/F03/F04/F07; synthetic IdP only."""
import logging
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from app.auth import SESSION_COOKIE
from app.main import create_app
from tests.conftest import HDR
from tests.test_auth import clock, idp, oidc_app, web, do_login, start_login


@pytest.mark.parametrize("value", [None, 913600, True, "1000000", -1, float("nan"), float("inf"), 1000100])
def test_step_up_requires_recent_numeric_auth_time(web, idp, value):
    idp.claims = {"auth_time": value}
    assert do_login(web, idp, step_up="true").status_code == 401
    assert web.get("/bff/me").status_code == 401


def test_step_up_allows_fresh_roundtrip_when_idp_omits_auth_time(web, idp, clock):
    # Manche Anbieter werben claims_supported ohne auth_time an; dann belegt der frische
    # Step-up-Roundtrip die erneute Anmeldung, statt privilegierte Aktionen dauerhaft zu sperren.
    idp.discovery_overrides = {"claims_supported": ["aud", "exp", "iat", "iss", "sub", "name", "preferred_username"]}
    idp.claims = {"auth_time": None}
    assert do_login(web, idp, step_up="true").status_code == 303
    assert web.get("/bff/me").json()["fresh"] is True


def test_step_up_stays_strict_when_idp_capability_unknown(web, idp):
    # Ohne claims_supported bleibt fehlendes auth_time ein Fail-closed 401, kein stiller Fallback.
    idp.discovery_overrides = {}
    idp.claims = {"auth_time": None}
    assert do_login(web, idp, step_up="true").status_code == 401


@pytest.mark.parametrize("value", [None, 913600, True, "1000000", 1000100])
def test_normal_sso_never_manufactures_freshness(web, idp, value):
    idp.claims = {"auth_time": value}
    assert do_login(web, idp).status_code == 303
    assert web.get("/bff/me").json()["fresh"] is False
    assert web.put("/bff/h/server/hermes/default/providers/key", json={"var": "OPENROUTER_API_KEY", "value": "synthetic"}).status_code == 401


def test_step_up_binds_request_time_and_preserves_old_session_on_failure(web, idp, clock):
    idp.claims = {"auth_time": clock.t}
    assert do_login(web, idp).status_code == 303
    sid = web.cookies.get(SESSION_COOKIE)
    clock.t += 120
    location = start_login(web, step_up="true")
    state = parse_qs(urlparse(location).query)["state"][0]
    code = idp.authorize(location)
    result = web.get("/auth/callback", params={"state": state, "code": code, "step_up": "false"}, follow_redirects=False)
    assert result.status_code == 401
    assert web.cookies.get(SESSION_COOKIE) == sid
    idp.claims = {"auth_time": clock.t}
    assert do_login(web, idp, step_up="true").status_code == 303
    assert web.get("/bff/me").json()["fresh"] is True
    assert web.cookies.get(SESSION_COOKIE) != sid


def test_normal_sso_preserves_actual_authentication_age(web, idp, clock):
    idp.claims = {"auth_time": clock.t - 590}
    assert do_login(web, idp).status_code == 303
    assert web.get("/bff/me").json()["fresh"] is True
    clock.t += 11
    assert web.get("/bff/me").json()["fresh"] is False


@pytest.mark.parametrize("declared", [None, "1"])
def test_actual_body_limit_rejects_stream_before_endpoint(make_settings, declared):
    from fastapi import Request
    app = create_app(make_settings(max_body_bytes=128))
    called = []

    @app.post("/bff/body-probe")
    async def probe(request: Request):
        called.append(True)
        return {"size": len(await request.body())}

    headers = dict(HDR)
    if declared:
        headers["Content-Length"] = declared
    with TestClient(app) as c:
        result = c.post("/bff/body-probe", content=iter([b"x" * 64] * 3), headers=headers)
    assert result.status_code == 413
    assert not called
    assert result.headers["x-content-type-options"] == "nosniff"
    assert result.headers["cache-control"] == "no-store"


def test_bounded_body_is_replayed_and_sse_is_not_buffered(make_settings):
    from fastapi import Request
    from starlette.responses import StreamingResponse
    app = create_app(make_settings(max_body_bytes=128))

    @app.post("/bff/echo-stream")
    async def stream(request: Request):
        body = await request.body()
        async def events():
            yield b"data: " + body + b"\n\n"
        return StreamingResponse(events(), media_type="text/event-stream")

    with TestClient(app) as c:
        result = c.post("/bff/echo-stream", content=iter([b"a" * 64, b"b" * 64]), headers=HDR)
        assert result.status_code == 200
        assert result.content == b"data: " + b"a" * 64 + b"b" * 64 + b"\n\n"
        assert result.headers["content-type"].startswith("text/event-stream")
        assert c.post("/bff/echo-stream", content=b"x").status_code == 403
        assert c.post("/bff/echo-stream", content=b"x", headers={**HDR, "Origin": "https://evil.test"}).status_code == 403


@pytest.mark.parametrize("target", [
    "/auth/callback?code=CODE_SECRET&state=STATE_SECRET&session_state=SESSION_SECRET",
    "/bff/hosts?access_token=TOKEN_SECRET&api_key=KEY_SECRET&page=2",
    "/bff/hosts?%63ode=CODE_SECRET&TOKEN=TOKEN_SECRET&page=2",
])
def test_access_log_redacts_credentials_without_suppressing_requests(target):
    from app.access_logging import CredentialQueryFilter
    record = logging.LogRecord("uvicorn.access", logging.INFO, "", 0, '%s - "%s %s HTTP/%s" %d', ("127.0.0.1", "GET", target, "1.1", 200), None)
    assert CredentialQueryFilter().filter(record) is True
    message = record.getMessage()
    assert "_SECRET" not in message
    assert "GET /" in message and "200" in message
    if "page=2" in target:
        assert "page=2" in message


def test_access_log_preserves_unrelated_requests_and_records():
    from app.access_logging import CredentialQueryFilter
    record = logging.LogRecord("uvicorn.access", logging.INFO, "", 0, '%s - "%s %s HTTP/%s" %d', ("127.0.0.1", "GET", "/bff/hosts?page=2", "1.1", 200), None)
    original = record.getMessage()
    assert CredentialQueryFilter().filter(record) is True
    assert record.getMessage() == original


@pytest.mark.parametrize("key", ["total", "total_nodes", "total_units"])
def test_graph_upstream_total_marks_partial_response(key):
    from app.memory import norm_graph
    graph = norm_graph({"nodes": [{"id": "a"}, {"id": "b"}], "edges": [{"source": "a", "target": "b"}], key: 84102}, 150)
    assert graph["truncated"] is True
    assert graph["total"] == 84102
    assert len(graph["nodes"]) == 2 and len(graph["edges"]) == 1


def test_graph_complete_and_locally_capped_responses():
    from app.memory import norm_graph
    payload = {"nodes": [{"id": "a"}, {"id": "b"}], "edges": [{"source": "a", "target": "b"}], "total": 2}
    assert norm_graph(payload, 2)["truncated"] is False
    graph = norm_graph(payload, 1)
    assert graph["truncated"] is True and not graph["edges"]


def test_body_limit_counts_individual_asgi_chunks_and_stops_early(make_settings):
    import asyncio
    from app.security import SecurityMiddleware
    reads, sent, called = [], [], []

    async def downstream(scope, receive, send):
        called.append(True)

    async def receive():
        reads.append(True)
        assert len(reads) <= 3, "must stop receiving immediately at the limit"
        return {"type": "http.request", "body": b"x" * 64, "more_body": True}

    async def send(message):
        sent.append(message)

    scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"}, "method": "POST", "scheme": "http", "path": "/bff/probe", "query_string": b"", "headers": [(b"host", b"testserver"), (b"x-requested-with", b"hermes-webui")], "server": ("testserver", 80)}
    asyncio.run(SecurityMiddleware(downstream, make_settings(max_body_bytes=128))(scope, receive, send))
    assert len(reads) == 3 and not called
    assert sent[0]["status"] == 413


def test_uvicorn_formatter_and_real_handler_keep_only_redacted_values():
    import io
    from uvicorn.logging import AccessFormatter
    from app.access_logging import CredentialQueryFilter
    output = io.StringIO()
    handler = logging.StreamHandler(output)
    handler.setFormatter(AccessFormatter('%(client_addr)s - "%(request_line)s" %(status_code)s', use_colors=False))
    handler.addFilter(CredentialQueryFilter())
    logger = logging.Logger("uvicorn.access")
    logger.addHandler(handler)
    logger.info('%s - "%s %s HTTP/%s" %d', "127.0.0.1", "GET", "/auth/callback?code=CODE_SECRET&state=STATE_SECRET", "1.1", 303)
    logger.info('%s - "%s %s HTTP/%s" %d', "127.0.0.1", "GET", "/healthz", "1.1", 200)
    assert "_SECRET" not in output.getvalue()
    assert "/auth/callback" in output.getvalue() and "/healthz" in output.getvalue()


@pytest.mark.parametrize("message,args", [
    ("GET /auth/callback?code=%s&state=%s", ("CODE_SECRET", "STATE_SECRET")),
    ("GET /bff/hosts?token=%(token)s&page=%(page)s", {"token": "TOKEN_SECRET", "page": 2}),
])
def test_access_filter_preserves_parameterized_log_format(message, args):
    from app.access_logging import CredentialQueryFilter
    record = logging.LogRecord("access", logging.INFO, "", 0, message, args, None) if isinstance(args, tuple) else logging.LogRecord("access", logging.INFO, "", 0, message, (args,), None)
    assert CredentialQueryFilter().filter(record) is True
    assert "_SECRET" not in record.getMessage()





