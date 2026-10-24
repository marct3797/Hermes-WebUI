import json
import re
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.testclient import TestClient

from app.redaction import FRAGMENT, RedactionMiddleware, redact_fragments

REAL = Path(__file__).parent / "fixtures" / "real"
MATRIX = (REAL / "real_provider_matrix_server.json").read_text()
PROVIDERS = (REAL / "real_providers_laptop_default.json").read_text()
STREAM = 'data: {"key": "«redacted:oc_s...87r9»"}\n\n'


@pytest.fixture
def client():
    app = FastAPI()
    app.add_middleware(RedactionMiddleware)
    app.get("/bff/h/server/_provider-matrix")(lambda: JSONResponse(json.loads(MATRIX)))
    app.get("/bff/h/laptop/hermes/default/providers")(lambda: JSONResponse(json.loads(PROVIDERS), headers={"X-Keep": "1"}))
    app.get("/bff/h/laptop/stream")(lambda: StreamingResponse(iter([STREAM]), media_type="text/event-stream"))
    app.get("/other")(lambda: JSONResponse({"k": "«redacted:abcd...wxyz»"}))
    return TestClient(app)


@pytest.mark.parametrize("path,source", [("/bff/h/server/_provider-matrix", MATRIX), ("/bff/h/laptop/hermes/default/providers", PROVIDERS)])
def test_real_fixtures_lose_every_fragment(client, path, source):
    assert FRAGMENT.search(source) and re.search(r"«redacted:[^»]+\.\.\.", source)  # die Fixture enthält wirklich Fragmente
    body = client.get(path).text
    assert "«redacted»" in body
    assert "redacted:" not in body and not re.search(r"[A-Za-z0-9]{2,4}\.\.\.[A-Za-z0-9]{2,4}", body)
    assert json.loads(body)  # bleibt gültiges JSON


def test_headers_survive_stream_and_other_paths_untouched(client):
    assert client.get("/bff/h/laptop/hermes/default/providers").headers["x-keep"] == "1"
    assert client.get("/bff/h/laptop/stream").text == STREAM
    assert "abcd...wxyz" in client.get("/other").text


def test_escaped_form_is_redacted():
    assert redact_fragments('{"a": "\\u00abredacted:ab...cd\\u00bb"}') == '{"a": "«redacted»"}'


def test_middleware_registered_and_no_server_header(make_settings):
    from app.main import create_app
    app = create_app(make_settings())
    assert RedactionMiddleware in [m.cls for m in app.user_middleware]
    with TestClient(app) as c:
        assert "server" not in c.get("/healthz").headers


def test_capture_script_reads_only_and_scrubs(tmp_path):
    import httpx
    from devtools.capture_fixtures import PATHS, capture
    seen = []

    def handler(request):
        seen.append((request.method, request.headers.get("cookie")))
        return httpx.Response(200, json={"key": "«redacted:oc_s...87r9»", "mail": "a.b@firma.de", "api_key": "sk-abcdefgh12345",
                                         "deliver": "discord:1538373888252055637", "ok": [{"token": "x"}]})
    client = httpx.Client(base_url="http://bff.test", headers={"Cookie": "s=1"}, transport=httpx.MockTransport(handler))
    assert capture(client, tmp_path) == list(PATHS)
    assert seen and all(m == "GET" and c == "s=1" for m, c in seen)
    text = (tmp_path / "real_jobs_list.json").read_text()
    for leak in ("87r9", "firma.de", "sk-abc", "1538373888", '"x"'):
        assert leak not in text
    assert json.loads(text)["key"] == "«redacted»"
