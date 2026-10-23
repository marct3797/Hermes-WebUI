import json
import os
import threading
import time

import pytest

from fastapi.testclient import TestClient

from app.events import validate_event
from app.main import create_app
from tests.conftest import BASE, HDR, hosts_config


def sse_events(text):
    out = []
    for block in text.strip().split("\n\n"):
        lines = [l for l in block.splitlines() if not l.startswith(":")]
        if lines:
            assert all(l.startswith("data: ") for l in lines), block  # BFF sendet unbenannte Frames
            ev = json.loads("\n".join(l[6:] for l in lines))
            validate_event(ev)
            out.append(ev)
    return out


def run(client, text, **kw):
    r = client.post(f"{BASE}/runs", json={"text": text, **kw})
    assert r.status_code == 202, r.text
    return r.json()


def events_of(client, info, base=BASE):
    return sse_events(client.get(f"{base}/runs/{info['run_id']}/events").text)


# --- Hosts und Registry -----------------------------------------------------------------------
def test_hosts_overview(client):
    data = client.get("/bff/hosts").json()
    hosts = {h["id"]: h for h in data["hosts"]}
    assert list(hosts) == ["hikari", "keyless", "down", "laptop"]
    hikari = hosts["hikari"]
    assert hikari["status"] == "online" and hikari["kind"] == "local"
    rt = hikari["runtimes"][0]
    assert rt["id"] == "hermes" and rt["version"] == "0.20.4-mock" and rt["status"] == "online"
    # ungültiger Agent-Name entfällt, Anzeigename aus der Config bleibt erhalten
    assert [a["id"] for a in rt["agents"]] == ["default", "omoikane", "ghost", "sora"]
    assert rt["agents"][-1]["label"] == "Sora"
    assert hosts["down"]["status"] == "unreachable" and hosts["down"]["detail"]
    laptop = hosts["laptop"]
    assert laptop["status"] == "unreachable" and "Phase 2" in laptop["detail"]
    assert [a["id"] for a in laptop["runtimes"][0]["agents"]] == ["default"]
    assert data["config_error"] is None


def test_hosts_never_expose_keys(client):
    text = client.get("/bff/hosts").text + client.get(f"{BASE}/status").text
    assert "dev-key" not in text and "api_key" not in text and "wrong" not in text


def test_registry_reloads_without_restart(client, hosts_file):
    cfg = hosts_config()
    cfg["hosts"][0]["runtimes"][0]["agents"] = ["default", "neu"]
    hosts_file.write_text(json.dumps(cfg))
    os.utime(hosts_file, (time.time() + 5, time.time() + 5))
    agents = client.get("/bff/hosts").json()["hosts"][0]["runtimes"][0]["agents"]
    assert [a["id"] for a in agents] == ["default", "neu"]


def test_broken_config_keeps_last_good_and_reports(client, hosts_file):
    assert client.get("/bff/hosts").json()["config_error"] is None  # gültige Fassung wird geladen
    hosts_file.write_text("{kaputt")
    os.utime(hosts_file, (time.time() + 5, time.time() + 5))
    data = client.get("/bff/hosts").json()
    assert [h["id"] for h in data["hosts"]][0] == "hikari"
    assert "ungültig" in data["config_error"]


def test_multiplex_off_allows_one_agent_only(client, hosts_file):
    cfg = hosts_config()
    cfg["hosts"][3]["runtimes"][0]["agents"] = ["default", "zweiter"]
    hosts_file.write_text(json.dumps(cfg))
    os.utime(hosts_file, (time.time() + 5, time.time() + 5))
    assert "genau ein Agent" in client.get("/bff/hosts").json()["config_error"]


# --- Status je Agent ----------------------------------------------------------------------------
def test_agent_status_online_with_features(client):
    st = client.get(f"{BASE}/status").json()
    assert st["state"] == "online" and st["online"] is True and st["version"] == "0.20.4-mock"
    assert {"runs", "approval", "steer", "stop", "fork", "model_lock", "reasoning", "skills", "idempotency"} <= set(st["features"])
    assert "memory_write_api" not in st["features"] and "memory_write" not in st["features"]  # Flag war false


@pytest.mark.parametrize("path,state", [
    ("/bff/h/keyless/hermes/default", "auth_error"),
    ("/bff/h/hikari/hermes/ghost", "gone"),
    ("/bff/h/down/hermes/default", "unreachable"),
    ("/bff/h/laptop/hermes/default", "unreachable"),
])
def test_agent_status_states(client, path, state):
    st = client.get(f"{path}/status").json()
    assert st["state"] == state and st["online"] is False and st["error"]


def test_remote_host_calls_report_503(client):
    assert client.get("/bff/h/laptop/hermes/default/sessions").status_code == 503
    r = client.post("/bff/h/laptop/hermes/default/runs", json={"text": "x"})
    assert r.status_code == 503 and "Phase 2" in r.json()["detail"]


def test_unknown_targets_404(client):
    for path in ("/bff/h/nope/hermes/default", "/bff/h/hikari/opencode/default", "/bff/h/hikari/hermes/unbekannt"):
        assert client.get(f"{path}/sessions").status_code == 404


def test_invalid_path_segments_rejected(client):
    assert client.get("/bff/h/HIKARI/hermes/default/status").status_code == 422
    assert client.get("/bff/h/hikari/hermes/..%2Fx/status").status_code in (404, 422)
    assert client.get(f"{BASE}/runs/..%2F..%2Fsecret").status_code in (404, 422)
    assert client.get(f"{BASE}/sessions/a%2Fb/messages").status_code in (404, 422)


def test_upstream_auth_failure_is_502_for_browser(client):
    assert client.get("/bff/h/keyless/hermes/default/sessions").status_code == 502


def test_profiles_are_isolated(client):
    run(client, "nur default")
    assert len(client.get(f"{BASE}/sessions").json()["data"]) == 1
    assert client.get("/bff/h/hikari/hermes/omoikane/sessions").json()["data"] == []


# --- Runs und Ereignisse -------------------------------------------------------------------------
def test_run_streams_normalized_events(client):
    info = run(client, "hallo")
    evs = events_of(client, info)
    types = [e["type"] for e in evs]
    assert types[0] == "run.started" and types[-1] == "run.completed"
    assert "reasoning.delta" in types
    text = "".join(e["text"] for e in evs if e["type"] == "message.delta")
    assert text.startswith("Hallo! Das ist eine **Mock-Antwort**")
    done = evs[-1]
    assert done["usage"] == {"input_tokens": 12, "output_tokens": 34, "total_tokens": 46}
    assert done["text"].startswith("Hallo!")


def test_tool_events_use_fifo_ids_and_millis(client):
    info = run(client, "bitte tool nutzen")
    tool = [e for e in events_of(client, info) if e["type"].startswith("tool.")]
    assert tool[0]["name"] == "terminal" and tool[0]["preview"] == "ls -la"
    assert tool[1]["id"] == tool[0]["id"] and tool[1]["ok"] is True and tool[1]["duration_ms"] == 41


def test_approval_event_choices(client):
    evs = events_of(client, run(client, "approval"))
    appr = next(e for e in evs if e["type"] == "approval.requested")
    assert appr["command"] == "rm -rf build/" and appr["reason"] == "Löscht Dateien"
    assert appr["choices"] == ["once", "session", "deny"] and appr["timeout_s"] == 300
    smart = next(e for e in events_of(client, run(client, "smart")) if e["type"] == "approval.requested")
    assert smart["choices"] == ["once", "deny"] and smart["smart_denied"] is True


def test_failure_and_stop(client):
    assert events_of(client, run(client, "fail"))[-1] == {"type": "run.failed", "error": "Mock-Fehler"}
    info = run(client, "hallo")
    assert client.post(f"{BASE}/runs/{info['run_id']}/stop").status_code == 200
    assert events_of(client, info)[-1]["type"] == "run.stopped"


def test_stream_is_single_subscription(client):
    info = run(client, "hallo")
    events_of(client, info)
    assert client.get(f"{BASE}/runs/{info['run_id']}/events").status_code == 404
    assert client.get(f"{BASE}/runs/{info['run_id']}").json()["status"] == "completed"


def test_session_listing_and_messages(client):
    info = run(client, "erste Nachricht")
    events_of(client, info)
    sessions = client.get(f"{BASE}/sessions").json()["data"]
    assert sessions[0]["id"] == info["session_id"]
    msgs = client.get(f"{BASE}/sessions/{info['session_id']}/messages").json()["data"]
    assert [m["role"] for m in msgs] == ["user", "assistant"]
    assert msgs[1]["reasoning"]


def test_tool_arguments_and_output_live_in_the_history(client):
    """Der Ereignisstrom meldet nur Name und Vorschau; Argumente und Ausgabe stehen erst im Verlauf."""
    info = run(client, "bitte tool nutzen")
    assert all("output" not in e for e in events_of(client, info) if e["type"].startswith("tool."))
    msgs = client.get(f"{BASE}/sessions/{info['session_id']}/messages").json()["data"]
    assert [m["role"] for m in msgs] == ["user", "assistant", "tool", "assistant"]
    call = msgs[1]["tool_calls"][0]
    assert call["function"]["name"] == "terminal" and msgs[2]["tool_call_id"] == call["id"]
    assert "notes.txt" in json.loads(msgs[2]["content"])["output"]


def test_messages_are_paginated(client):
    info = run(client, "erste Nachricht")
    events_of(client, info)
    page = client.get(f"{BASE}/sessions/{info['session_id']}/messages", params={"limit": 1, "offset": 1}).json()
    assert [m["role"] for m in page["data"]] == ["assistant"]
    assert page["pagination"]["total"] == 2 and page["pagination"]["has_more"] is False


def test_fork_session(client):
    info = run(client, "erste Nachricht")
    events_of(client, info)
    fork = client.post(f"{BASE}/sessions/{info['session_id']}/fork")
    assert fork.status_code == 200 and fork.json()["session_id"] != info["session_id"]
    copied = client.get(f"{BASE}/sessions/{fork.json()['session_id']}/messages").json()["data"]
    assert [m["role"] for m in copied] == ["user", "assistant"]
    assert client.post(f"{BASE}/sessions/nope/fork").status_code == 404


def test_idempotency_key_replays_the_same_run(client):
    a = run(client, "hallo", idempotency_key="key-1")
    b = run(client, "hallo", idempotency_key="key-1")
    assert a["run_id"] == b["run_id"]
    assert client.post(f"{BASE}/runs", json={"text": "x", "idempotency_key": "../x"}).status_code == 422


def test_models(client):
    opts = client.get(f"{BASE}/models").json()
    assert opts["model"] == "mock-large" and opts["providers"][0]["models"] == ["mock-large", "mock-small"]


def test_steer_only_while_running(client):
    info = run(client, "hallo")
    events_of(client, info)
    r = client.post(f"{BASE}/runs/{info['run_id']}/steer", json={"text": "anders"})
    assert r.status_code == 409  # Run ist schon fertig


def test_approval_round_trip_with_waiting_run(make_settings):
    import httpx
    from fastapi.testclient import TestClient

    from app.main import create_app
    from devtools.mock_hermes import create_mock
    from tests.conftest import HDR, RouterTransport

    mock = create_mock(wait_for_user=True, delay=0)
    app = create_app(make_settings(), transport=RouterTransport({"hermes.test": httpx.ASGITransport(app=mock)}))
    with TestClient(app) as c:
        c.headers.update(HDR)
        info = run(c, "approval bitte")
        result = {}
        t = threading.Thread(target=lambda: result.setdefault("evs", events_of(c, info)))
        t.start()
        for _ in range(100):  # warten, bis der Run auf die Freigabe wartet
            if c.get(f"{BASE}/runs/{info['run_id']}").json()["status"] == "waiting_for_approval":
                break
            time.sleep(0.02)
        assert c.post(f"{BASE}/runs/{info['run_id']}/approval", json={"decision": "once"}).status_code == 200
        t.join(5)
        types = [e["type"] for e in result["evs"]]
        assert types.index("approval.requested") < types.index("approval.responded") < types.index("run.completed")
        responded = next(e for e in result["evs"] if e["type"] == "approval.responded")
        assert responded["choice"] == "once"


def test_approval_decision_validation_and_conflict(client):
    info = run(client, "hallo")
    base = f"{BASE}/runs/{info['run_id']}"
    assert client.post(f"{base}/approval", json={"decision": "yolo"}).status_code == 422
    assert client.post(f"{base}/approval", json={"decision": "once"}).status_code == 409  # nichts offen


def test_validation(client):
    assert client.post(f"{BASE}/runs", json={"text": ""}).status_code == 422
    assert client.post(f"{BASE}/runs", json={"text": "x", "session_id": "../x"}).status_code == 422
    assert client.post(f"{BASE}/runs", json={"text": "x", "images": ["http://evil/x.png"]}).status_code == 422
    ok = "data:image/png;base64,iVBORw0KGgo="
    assert client.post(f"{BASE}/runs", json={"text": "x", "images": [ok]}).status_code == 202


# --- Alte Links ---------------------------------------------------------------------------------
def test_legacy_profile_links_redirect(client):
    r = client.get("/p/raiden/chat/abc", follow_redirects=False)
    assert r.status_code == 308 and r.headers["location"] == "/h/hikari/hermes/raiden/chat/abc"
    assert client.get("/p/raiden", follow_redirects=False).headers["location"] == "/h/hikari/hermes/raiden/chat"
    assert client.get("/p/..%2Fx", follow_redirects=False).status_code in (404, 422)


# --- Diagnose-Ring --------------------------------------------------------------------------------
def by_id(report):
    return {c["id"]: c for c in report["checks"]}


def test_diagnose_reads_a_healthy_agent(client):
    report = client.get(f"{BASE}/diagnose").json()
    c = by_id(report)
    assert c["health"]["status"] == c["features"]["status"] == c["models"]["status"] == c["sessions"]["status"] == "ok"
    assert c["history"]["status"] == "warn" and report["status"] == "warn"  # noch keine Session zum Prüfen


def test_diagnose_checks_history_with_tool_results(client):
    events_of(client, run(client, "bitte tool nutzen"))
    c = by_id(client.get(f"{BASE}/diagnose").json())
    assert c["history"]["status"] == "ok" and "1 Tool-Aufrufe, 1 Ergebnisse" in c["history"]["detail"]


def test_diagnose_reports_an_unreachable_agent_without_failing(client):
    report = client.get("/bff/h/down/hermes/default/diagnose").json()
    assert report["status"] == "fail" and [c["id"] for c in report["checks"]] == ["health"]
    assert client.get("/bff/h/hikari/hermes/ghost/diagnose").json()["status"] == "fail"


def test_diagnose_run_test_completes_a_real_run(client):
    report = client.post(f"{BASE}/diagnose/run").json()
    c = by_id(report)
    assert report["status"] == "ok", report
    assert list(c) == ["run.start", "run.stream", "run.history"]
    assert client.get(f"{BASE}/sessions").json()["data"], "der Lauftest legt eine Session an"


# --- Sessions umbenennen und löschen (nur gegen den Mock) ---------------------------------------------------
def test_rename_session(client):
    info = run(client, "erste Nachricht")
    events_of(client, info)
    r = client.patch(f"{BASE}/sessions/{info['session_id']}", json={"title": "Neuer Name"})
    assert r.status_code == 200 and r.json()["title"] == "Neuer Name"
    assert client.get(f"{BASE}/sessions").json()["data"][0]["title"] == "Neuer Name"
    assert client.patch(f"{BASE}/sessions/{info['session_id']}", json={"title": "   "}).status_code == 422
    assert client.patch(f"{BASE}/sessions/{info['session_id']}", json={"title": "x" * 101}).status_code == 422
    assert client.patch(f"{BASE}/sessions/nope", json={"title": "x"}).status_code == 404


def test_rename_to_an_existing_title_is_a_conflict(client):
    a, b = run(client, "eins"), run(client, "zwei")
    events_of(client, a), events_of(client, b)
    r = client.patch(f"{BASE}/sessions/{b['session_id']}", json={"title": "eins"})
    assert r.status_code == 409


def test_delete_session_and_its_audit_entry(client):
    info = run(client, "wegwerfen")
    events_of(client, info)
    assert client.delete(f"{BASE}/sessions/{info['session_id']}").json() == {"ok": True}
    assert client.get(f"{BASE}/sessions").json()["data"] == []
    assert client.delete(f"{BASE}/sessions/{info['session_id']}").status_code == 404


def test_delete_is_refused_while_a_run_is_active(client):
    info = run(client, "hallo")  # Strom nicht abonniert: der Run gilt als laufend
    assert client.delete(f"{BASE}/sessions/{info['session_id']}").status_code == 409


# --- Skills und Toolsets ---------------------------------------------------------------------------------------
def test_skills_and_toolsets_are_passed_through(client):
    skills = client.get(f"{BASE}/skills").json()["data"]
    assert {s["name"] for s in skills} >= {"github-pr-review", "plan"}
    sets = {t["name"]: t for t in client.get(f"{BASE}/toolsets").json()["data"]}
    assert sets["terminal"]["enabled"] is True and sets["web"]["configured"] is False and sets["browser"]["tools"] == ["browser_navigate"]


def test_skills_of_an_offline_host_is_503_and_unknown_agent_404(client):
    assert client.get("/bff/h/laptop/hermes/default/skills").status_code == 503
    assert client.get("/bff/h/hikari/hermes/ghost/toolsets").status_code == 404


def test_me_reports_the_build_when_one_is_set(make_settings):
    for build, expected in (("3f5c30c", "3f5c30c"), ("", None)):
        with TestClient(create_app(make_settings(build=build))) as c:
            c.headers.update(HDR)
            assert c.get("/bff/me").json()["build"] == expected
