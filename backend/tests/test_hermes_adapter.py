"""Hermes-Adapter gegen das Format aus der Quelltext-Lesung (Fakten-Datei, 2026-10-22)."""
import json

import httpx
import pytest

from app.adapters import RunInput, UpstreamError
from app.adapters.hermes import HermesAdapter, HermesEventTranslator, features_from_capabilities, parse_sse
from app.events import REQUIRED_FIELDS, TERMINAL_TYPES, validate_event
from app.registry import AgentCfg, RuntimeCfg


def cfg(multiplex=True, key="k"):
    return RuntimeCfg("hermes", "http://h.test:9121", key, multiplex, (AgentCfg("raiden", "raiden"),))


def adapter(handler, **kw):
    return HermesAdapter(cfg(**kw), httpx.AsyncClient(transport=httpx.MockTransport(handler)))


def tr(event, **data):
    t = HermesEventTranslator("run_1")
    return t.translate("", json.dumps({"event": event, **data}))


# --- SSE ----------------------------------------------------------------------------------
async def test_parse_sse_data_only_frames_and_comments():
    async def lines():
        for l in ['data: {"event":"a"}', "", ": keepalive", 'data: {"event":"b"}', "", ": stream closed"]:
            yield l
    assert [e async for e in parse_sse(lines())] == [("", '{"event":"a"}'), ("", '{"event":"b"}')]


async def test_parse_sse_named_events_and_multiline():
    async def lines():
        for l in ["event: x", "data: 1", "data: 2", "", "data: solo", ""]:
            yield l
    assert [e async for e in parse_sse(lines())] == [("x", "1\n2"), ("", "solo")]


# --- Übersetzung ----------------------------------------------------------------------------
def test_event_name_comes_from_json_not_sse_line():
    t = HermesEventTranslator("r")
    assert t.translate("ignored", '{"event":"message.delta","delta":"Hi"}') == {"type": "message.delta", "text": "Hi"}
    assert t.translate("message.delta", '{"delta":"x"}')["text"] == "x"  # Fallback: benannter Frame


@pytest.mark.parametrize("event,payload,expected", [
    ("message.delta", {"delta": "Hal"}, {"type": "message.delta", "text": "Hal"}),
    ("reasoning.available", {"text": "denke"}, {"type": "reasoning.delta", "text": "denke"}),
    ("run.steered", {"accepted": True}, {"type": "run.steered", "accepted": True}),
    ("run.cancelled", {}, {"type": "run.stopped"}),
    ("run.failed", {"error": "kaputt"}, {"type": "run.failed", "error": "kaputt"}),
    ("approval.responded", {"choice": "once", "resolved": 1}, {"type": "approval.responded", "choice": "once", "resolved": 1}),
])
def test_simple_events(event, payload, expected):
    assert tr(event, **payload) == expected


def test_run_completed_keeps_only_token_counts_and_pending_steer():
    ev = tr("run.completed", output="fertig", usage={"input_tokens": 1, "output_tokens": 2, "total_tokens": 3, "cost": 9},
            pending_steer="und noch")
    assert ev == {"type": "run.completed", "usage": {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3},
                  "text": "fertig", "pending_steer": "und noch"}
    assert tr("run.completed", output="x")["usage"] is None


def test_tools_are_matched_in_order_per_name():
    t = HermesEventTranslator("r")
    s = lambda name, **d: t.translate("", json.dumps({"event": name, **d}))
    a = s("tool.started", tool="terminal", preview="ls")
    b = s("tool.started", tool="terminal", preview="pwd")
    c = s("tool.started", tool="read_file", preview="a.txt")
    done_a = s("tool.completed", tool="terminal", duration=1.5, error=False)
    done_c = s("tool.completed", tool="read_file", duration=0.25, error=True)
    done_b = s("tool.completed", tool="terminal", duration=0.001, error=False)
    assert (done_a["id"], done_b["id"], done_c["id"]) == (a["id"], b["id"], c["id"])
    assert a["id"] != b["id"]
    assert done_a["duration_ms"] == 1500 and done_a["ok"] is True
    assert done_c["ok"] is False and done_c["duration_ms"] == 250
    assert done_b["duration_ms"] == 1


def test_tool_completed_without_start_gets_fresh_id():
    ev = tr("tool.completed", tool="x", duration=None, error=False)
    assert ev["id"] and ev["duration_ms"] is None


def test_explicit_tool_ids_win():
    assert tr("tool.started", tool="t", tool_call_id="call_9")["id"] == "call_9"


def test_approval_request_maps_fields():
    ev = tr("approval.request", command="rm -rf /tmp/x", description="Löscht", pattern_key="rm", choices=["once", "session", "deny", "bogus"])
    assert ev["type"] == "approval.requested" and ev["reason"] == "Löscht" and ev["pattern_key"] == "rm"
    assert ev["choices"] == ["once", "session", "deny"] and ev["timeout_s"] == 300 and ev["smart_denied"] is False


def test_approval_defaults_are_conservative():
    assert tr("approval.request", command="x")["choices"] == ["once", "deny"]
    assert tr("approval.request", command="x", choices=["bogus"])["choices"] == ["deny"]
    assert tr("approval.request", command="x", smart_denied=True, choices=["once", "deny"])["smart_denied"] is True


def test_subagent_and_unknown_events():
    assert tr("subagent.start", subagent_id="s1", goal="g") == {"type": "subagent.started", "id": "s1", "data": {"subagent_id": "s1", "goal": "g"}}
    assert tr("subagent.complete", subagent_id="s1")["type"] == "subagent.completed"
    unknown = tr("brand.new", x=1)
    assert unknown == {"type": "unknown", "name": "brand.new", "data": {"x": 1}}
    t = HermesEventTranslator("r")
    assert t.translate("", "kein json")["type"] == "unknown"
    assert t.translate("", "[1,2]")["type"] == "unknown"


def test_every_translated_event_matches_the_common_format():
    samples = [
        ("message.delta", {"delta": "a"}), ("reasoning.available", {"text": "b"}), ("tool.started", {"tool": "t"}),
        ("tool.completed", {"tool": "t"}), ("approval.request", {"command": "c"}), ("approval.responded", {"choice": "once"}),
        ("run.steered", {"accepted": True}), ("subagent.start", {}), ("subagent.complete", {}), ("run.completed", {}),
        ("run.failed", {"error": "e"}), ("run.cancelled", {}), ("nope", {}),
    ]
    seen = set()
    for name, data in samples:
        ev = tr(name, **data)
        validate_event(ev)
        seen.add(ev["type"])
    assert {"run.completed", "run.failed", "run.stopped"} <= seen


def test_validate_event_rejects_bad_events():
    with pytest.raises(ValueError):
        validate_event({"type": "gibt.es.nicht"})
    with pytest.raises(ValueError):
        validate_event({"type": "message.delta"})
    assert TERMINAL_TYPES <= set(REQUIRED_FIELDS)


# --- Fähigkeiten --------------------------------------------------------------------------------
def test_features_from_capabilities():
    base = features_from_capabilities({})
    assert {"runs", "stop", "approval", "steer"} <= base
    caps = features_from_capabilities({"steer": False, "memory_write_api": False, "reasoning_stream": True})
    assert "steer" not in caps and "reasoning_stream" in caps and "memory_write_api" not in caps
    assert features_from_capabilities({"features": {"stop": False}}) == base - {"stop"}
    assert features_from_capabilities("seltsam") == base


# --- HTTP ---------------------------------------------------------------------------------------
async def test_requests_use_profile_prefix_and_key():
    seen = []

    def handler(req: httpx.Request):
        seen.append(req)
        return httpx.Response(202, json={"run_id": "run_7", "session_id": "s1"})

    a = adapter(handler)
    info = await a.start_run("raiden", RunInput("hi", session_id="s0", model="m", images=("data:image/png;base64,AA==",)))
    assert info.run_id == "run_7" and info.session_id == "s1"
    req = seen[0]
    assert str(req.url) == "http://h.test:9121/p/raiden/v1/runs" and req.headers["authorization"] == "Bearer k"
    body = json.loads(req.content)
    assert body["session_id"] == "s0" and body["model"] == "m"
    assert body["input"][0]["content"][1] == {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}}


async def test_no_prefix_without_multiplex_and_plain_text_input():
    seen = []

    def handler(req):
        seen.append(req)
        return httpx.Response(202, json={"run_id": "r"})

    await adapter(handler, multiplex=False).start_run("default", RunInput("hi"))
    assert str(seen[0].url) == "http://h.test:9121/v1/runs" and json.loads(seen[0].content) == {"input": "hi"}


async def test_actions_use_hermes_field_names():
    seen = []

    def handler(req):
        seen.append((req.method, req.url.path, json.loads(req.content or b"{}")))
        return httpx.Response(200, json={"ok": True})

    a = adapter(handler)
    await a.approve("raiden", "r1", "session")
    await a.steer("raiden", "r1", "anders")
    await a.stop("raiden", "r1")
    await a.clarify("raiden", "r1", "build", "c1")
    assert seen == [
        ("POST", "/p/raiden/v1/runs/r1/approval", {"choice": "session"}),
        ("POST", "/p/raiden/v1/runs/r1/steer", {"input": "anders"}),
        ("POST", "/p/raiden/v1/runs/r1/stop", {}),
        ("POST", "/p/raiden/v1/runs/r1/clarify", {"answer": "build", "clarify_id": "c1"}),
    ]


async def test_start_run_without_run_id_is_an_error():
    with pytest.raises(UpstreamError) as e:
        await adapter(lambda req: httpx.Response(202, json={})).start_run("raiden", RunInput("hi"))
    assert e.value.status == 502


async def test_events_stream_translates_frames():
    body = "\n\n".join([
        'data: {"event":"message.delta","run_id":"r","delta":"Hi"}',
        ": keepalive",
        'data: {"event":"run.completed","run_id":"r","output":"Hi","usage":{"total_tokens":3}}',
        ": stream closed",
    ]) + "\n\n"
    a = adapter(lambda req: httpx.Response(200, content=body.encode(), headers={"content-type": "text/event-stream"}))
    evs = [e async for e in a.events("raiden", "r")]
    assert [e["type"] for e in evs] == ["run.started", "message.delta", "run.completed"]
    assert evs[-1]["usage"] == {"total_tokens": 3}


async def test_events_errors_before_first_event():
    a = adapter(lambda req: httpx.Response(404, json={"error": {"message": "run_not_found"}}))
    with pytest.raises(UpstreamError) as e:
        async for _ in a.events("raiden", "r"):
            pass
    assert e.value.status == 404 and "run_not_found" in e.value.detail


# --- Probe --------------------------------------------------------------------------------------
def probe_handler(health=200, caps=200):
    def handler(req: httpx.Request):
        if req.url.path == "/health":
            return httpx.Response(health, json={"status": "ok", "version": "0.20.4"}) if health == 200 else httpx.Response(health)
        return httpx.Response(caps, json={"steer": True} if caps == 200 else {"error": {"message": "x"}})
    return handler


async def test_probe_states():
    ok = await adapter(probe_handler()).probe("raiden")
    assert ok.state == "online" and ok.version == "0.20.4" and "steer" in ok.features
    assert (await adapter(probe_handler(caps=401)).probe("raiden")).state == "auth_error"
    assert (await adapter(probe_handler(caps=404)).probe("raiden")).state == "gone"
    assert (await adapter(probe_handler(caps=404), multiplex=False).probe("default")).state == "unsupported"
    assert (await adapter(probe_handler(health=503)).probe("raiden")).state == "unreachable"
    assert (await adapter(probe_handler(caps=500)).probe("raiden")).state == "unreachable"


async def test_health_ignores_html_pages():
    """Auf dem Laptop liefert ein Dashboard unter /health HTML mit 200; das ist kein API-Server."""
    a = adapter(lambda req: httpx.Response(200, html="<html>Dashboard</html>"))
    assert (await a.health()).state == "unreachable"


async def test_connection_errors_become_unreachable():
    def handler(req):
        raise httpx.ConnectError("nein", request=req)
    assert (await adapter(handler).health()).state == "unreachable"
    with pytest.raises(UpstreamError) as e:
        await adapter(handler).models("raiden")
    assert e.value.status == 502
