import json

import pytest

from app.config import Settings
from app.hermes import normalize_event, parse_sse
from app.main import create_app


def sse_events(text):
    out = []
    for block in text.strip().split("\n\n"):
        lines = dict(l.split(": ", 1) for l in block.splitlines() if not l.startswith(":"))
        out.append((lines["event"], json.loads(lines["data"])))
    return out


def run(client, text, **kw):
    r = client.post("/bff/p/default/runs", json={"text": text, **kw})
    assert r.status_code == 202, r.text
    return r.json()


def test_profiles_hide_keys_and_invalid_names(client):
    r = client.get("/bff/profiles")
    names = [p["name"] for p in r.json()["profiles"]]
    assert names == ["default", "bad"]
    assert "api_key" not in r.text and "dev-key" not in r.text


def test_profiles_file_reload(client, profiles_file):
    profiles_file.write_text(json.dumps({"profiles": [{"name": "neu", "base_url": "http://hermes.test"}]}))
    import os, time
    os.utime(profiles_file, (time.time() + 5, time.time() + 5))
    assert [p["name"] for p in client.get("/bff/profiles").json()["profiles"]] == ["neu"]


def test_status_online_and_upstream_auth_failure(client):
    assert client.get("/bff/p/default/status").json()["online"] is True
    bad = client.get("/bff/p/bad/status").json()
    assert bad["online"] is False and bad["status"] == 401


def test_upstream_401_is_502_for_browser(client):
    assert client.get("/bff/p/bad/sessions").status_code == 502


def test_unknown_profile_404(client):
    assert client.get("/bff/p/nope/sessions").status_code == 404


def test_path_traversal_ids_rejected(client):
    assert client.get("/bff/p/default/runs/..%2F..%2Fsecret").status_code in (404, 422)
    assert client.get("/bff/p/default/sessions/a%2Fb/messages").status_code in (404, 422)


def test_run_streams_normalized_events(client):
    info = run(client, "hallo")
    r = client.get(f"/bff/p/default/runs/{info['run_id']}/events")
    evs = sse_events(r.text)
    types = [t for t, _ in evs]
    assert types[0] == "run.started" and types[-1] == "run.completed"
    assert "reasoning.delta" in types
    text = "".join(d["text"] for t, d in evs if t == "message.delta")
    assert text.startswith("Hallo! Das ist eine **Mock-Antwort**")


def test_tool_events(client):
    info = run(client, "bitte tool nutzen")
    evs = sse_events(client.get(f"/bff/p/default/runs/{info['run_id']}/events").text)
    tool = [d for t, d in evs if t.startswith("tool.")]
    assert tool[0]["name"] == "terminal" and tool[0]["preview"] == "ls -la"
    assert tool[1]["ok"] is True and tool[1]["duration_ms"] == 41


def test_approval_event_and_failure(client):
    info = run(client, "approval")
    evs = sse_events(client.get(f"/bff/p/default/runs/{info['run_id']}/events").text)
    appr = next(d for t, d in evs if t == "approval.requested")
    assert appr["command"] == "rm -rf build/" and appr["timeout_s"] == 300
    info = run(client, "fail")
    evs = sse_events(client.get(f"/bff/p/default/runs/{info['run_id']}/events").text)
    assert evs[-1][0] == "run.failed"


def test_session_listing_and_messages(client):
    info = run(client, "erste Nachricht")
    client.get(f"/bff/p/default/runs/{info['run_id']}/events")
    sessions = client.get("/bff/p/default/sessions").json()["sessions"]
    assert sessions[0]["id"] == info["session_id"]
    msgs = client.get(f"/bff/p/default/sessions/{info['session_id']}/messages").json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant"]


def test_approval_and_stop_actions(client):
    info = run(client, "hallo")
    base = f"/bff/p/default/runs/{info['run_id']}"
    assert client.post(f"{base}/approval", json={"decision": "once"}).status_code == 200
    assert client.post(f"{base}/approval", json={"decision": "yolo"}).status_code == 422
    assert client.post(f"{base}/clarify", json={"answer": "build"}).status_code == 200
    assert client.post(f"{base}/stop").status_code == 200


def test_validation(client):
    assert client.post("/bff/p/default/runs", json={"text": ""}).status_code == 422
    assert client.post("/bff/p/default/runs", json={"text": "x", "session_id": "../x"}).status_code == 422
    assert client.post("/bff/p/default/runs", json={"text": "x", "images": ["http://evil/x.png"]}).status_code == 422
    ok = "data:image/png;base64,iVBORw0KGgo="
    assert client.post("/bff/p/default/runs", json={"text": "x", "images": [ok]}).status_code == 202


# --- Sicherheit ---------------------------------------------------------------------------
def test_csrf_header_required(client):
    r = client.post("/bff/p/default/runs", json={"text": "x"}, headers={"X-Requested-With": ""})
    assert r.status_code == 403


def test_foreign_origin_rejected(client):
    r = client.post("/bff/p/default/runs", json={"text": "x"}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403


def test_security_headers(client):
    h = client.get("/healthz").headers
    assert "default-src 'self'" in h["content-security-policy"]
    assert h["x-frame-options"] == "DENY" and h["x-content-type-options"] == "nosniff"
    assert client.get("/bff/profiles").headers["cache-control"] == "no-store"


def test_bad_host_rejected(client):
    assert client.get("/healthz", headers={"Host": "evil.example"}).status_code == 400


def test_body_limit(client):
    r = client.post("/bff/p/default/runs", content=b"x" * 10, headers={"Content-Length": str(5_000_000), "Content-Type": "application/json"})
    assert r.status_code == 413


def test_rate_limit(profiles_file):
    import httpx
    from fastapi.testclient import TestClient
    from devtools.mock_hermes import create_mock
    app = create_app(Settings(profiles_file=profiles_file, runs_per_minute=2),
                     transport=httpx.ASGITransport(app=create_mock(False, 0)))
    with TestClient(app) as c:
        c.headers["X-Requested-With"] = "hermes-webui"
        codes = [c.post("/bff/p/default/runs", json={"text": "x"}).status_code for _ in range(3)]
    assert codes == [202, 202, 429]


def test_prod_requires_auth(profiles_file):
    with pytest.raises(RuntimeError):
        create_app(Settings(env="prod", auth_mode="none", profiles_file=profiles_file))


# --- Adapter ----------------------------------------------------------------------------
def test_normalize_unknown_and_malformed():
    assert normalize_event("weird.event", "{}")["type"] == "unknown"
    assert normalize_event("assistant.delta", "plain")["text"] == "plain"
    assert normalize_event("run.failed", '{"error": "x"}')["error"] == "x"


async def test_parse_sse():
    async def lines():
        for l in ["event: a", "data: 1", "data: 2", "", ": c", "data: solo", ""]:
            yield l
    assert [e async for e in parse_sse(lines())] == [("a", "1\n2"), ("message", "solo")]
