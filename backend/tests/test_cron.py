"""Zeitpläne und Logs über das Dashboard (BFF-Routen unter /bff/h/{host}/_cron und _logs) gegen devtools/mock_cron.py."""
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import SESSION_COOKIE, User
from app.main import create_app
from devtools.mock_cron import create_mock
from tests.conftest import HDR, RouterTransport

CRON = "/bff/h/ct/_cron/alpha"
SYSTEM_ID = "d935fe014c20"
AGENT_ID = "dcba8b738849"


@pytest.fixture
def env(tmp_path, make_settings):
    f = tmp_path / "hosts.json"
    agent = {"id": "hermes", "base_url": "http://hermes.test", "api_key": "k", "multiplex": True, "agents": ["default", "alpha"]}
    f.write_text(json.dumps({"hosts": [{"id": "ct", "runtimes": [{**agent, "dashboard": {"base_url": "http://dash.test"}}]}, {"id": "plain", "runtimes": [agent]}]}))
    dash = create_mock()
    settings = make_settings(hosts_file=f, auth_mode="oidc", oidc_issuer="https://id.test", oidc_client_id="t", oidc_client_secret="t", oidc_allowed_sub="user", public_url="http://testserver")
    app = create_app(settings, transport=RouterTransport({"dash.test": httpx.ASGITransport(app=dash)}))
    with TestClient(app) as c:
        s = app.state.sessions.create(User("user", "Test"))
        s.auth_time = app.state.sessions.now()
        c.cookies.set(SESSION_COOKIE, s.id)
        c.headers.update(HDR)
        c.dash, c.audit_file = dash, settings.audit_file
        yield c


def writes(dash):
    return [c for c in dash.state.calls if c[0] in ("POST", "PUT", "DELETE")]


def test_list_maps_real_shapes_and_hides_internals(env):
    r = env.get(f"{CRON}/schedules").json()
    by = {j["name"]: j for j in r["jobs"]}
    assert set(by) == {"db-check", "tagescheck", "wochenbericht"}
    s = by["db-check"]
    assert s["system"] is True and s["schedule"]["display"] == "30 4 * * *" and s["last_status"] == "ok" and s["latest"]["status"] == "completed"
    assert by["wochenbericht"]["state"] == "paused" and by["wochenbericht"]["schedule"]["kind"] == "interval" and by["wochenbericht"]["skills"] == ["plan"]
    text = json.dumps(r)
    assert "hermes_home" not in text and "/opt/" not in text and "origin" not in text
    assert env.dash.state.calls[-1][2] == {"profile": "alpha"}


def test_detail_runs_targets_blueprints_skills(env):
    assert env.get(f"{CRON}/schedules/{AGENT_ID}").json()["name"] == "tagescheck"
    assert env.get(f"{CRON}/schedules/{'a' * 12}").status_code == 404
    runs = env.get(f"{CRON}/schedules/{SYSTEM_ID}/runs", params={"limit": 2}).json()["runs"]
    assert len(runs) == 2 and runs[0]["duration_s"] == 0 and runs[0]["status"] == "COMPLETED" and "Cron Job" in runs[0]["preview"]
    assert env.dash.state.calls[-1][2] == {"profile": "alpha", "limit": "2"}
    assert [t["id"] for t in env.get(f"{CRON}/targets").json()["targets"]] == ["local", "bot-chat:alpha"]
    bps = env.get(f"{CRON}/blueprints").json()["blueprints"]
    assert bps[0]["key"] == "morning-brief" and bps[0]["fields"][0]["name"] == "time"
    assert env.get(f"{CRON}/skill-names").json() == {"skills": ["codex", "plan"]}
    assert env.get(f"{CRON}/schedules/{SYSTEM_ID}/runs", params={"limit": 0}).status_code == 422


def test_unknown_profile_and_host(env):
    assert env.get("/bff/h/ct/_cron/ghost/schedules").status_code == 404
    assert env.get("/bff/h/nope/_cron/alpha/schedules").status_code == 404
    assert env.get("/bff/h/plain/_cron/alpha/schedules").status_code == 503  # kein Dashboard eingerichtet
    assert env.get("/bff/h/ct/_cron/../schedules").status_code in (404, 422)


def test_create_is_always_paused_and_audited_without_content(env):
    r = env.post(f"{CRON}/schedules", json={"name": "neu", "schedule": "every 30m", "prompt": "Geheimer Prompt", "deliver": "local", "skills": ["plan"], "repeat": 3})
    assert r.status_code == 200
    job = r.json()
    assert job["state"] == "paused" and job["enabled"] is False and job["repeat"]["times"] == 3
    sent = writes(env.dash)[-1][3]
    assert sent["paused"] is True and sent["prompt"] == "Geheimer Prompt"
    audit = env.audit_file.read_text()
    assert "cron.create" in audit and job["id"] in audit and "Geheimer Prompt" not in audit
    assert env.get(f"{CRON}/schedules/{job['id']}").json()["state"] == "paused"  # bleibt pausiert, bis jemand aktiviert


def test_create_validation(env):
    ok = {"schedule": "30m", "prompt": "x"}
    for bad in ({**ok, "schedule": ""}, {**ok, "schedule": "x" * 201}, {**ok, "prompt": ""}, {**ok, "prompt": "x" * 20001}, {**ok, "name": "n" * 201}, {**ok, "repeat": 0},
                {**ok, "repeat": 1_000_001}, {**ok, "skills": ["a"] * 31}, {**ok, "skills": ["../x"]}, {**ok, "script": "x.sh"}, {**ok, "no_agent": True}, {**ok, "paused": False},
                {**ok, "schedule": "a\nb"}):
        assert env.post(f"{CRON}/schedules", json=bad).status_code == 422, bad
    assert not writes(env.dash)
    assert env.post(f"{CRON}/schedules", json={**ok, "deliver": "gibts-nicht"}).status_code == 422  # nicht in den Zustellzielen
    assert not writes(env.dash)
    bad = env.post(f"{CRON}/schedules", json={**ok, "schedule": "irgendwann"})
    assert bad.status_code == 502 and "Invalid schedule" in bad.json()["detail"]  # Dashboard-Grund wird durchgereicht


def test_update_sends_only_changes_and_checks_target(env):
    r = env.put(f"{CRON}/schedules/{AGENT_ID}", json={"schedule": "0 9 * * *", "prompt": "Neu", "deliver": "bot-chat:alpha", "repeat": 5})
    assert r.status_code == 200 and r.json()["schedule"]["expr"] == "0 9 * * *"
    assert writes(env.dash)[-1][3] == {"updates": {"schedule": "0 9 * * *", "prompt": "Neu", "deliver": "bot-chat:alpha", "repeat": 5}}
    env.put(f"{CRON}/schedules/{AGENT_ID}", json={"repeat_unlimited": True})
    assert writes(env.dash)[-1][3] == {"updates": {"repeat": None}}
    assert env.put(f"{CRON}/schedules/{AGENT_ID}", json={}).status_code == 422
    assert env.put(f"{CRON}/schedules/{AGENT_ID}", json={"deliver": "fremd"}).status_code == 422
    assert env.put(f"{CRON}/schedules/{AGENT_ID}", json={"script": "boese.sh"}).status_code == 422  # Skriptnamen sind nicht setzbar
    assert env.put(f"{CRON}/schedules/{'b' * 12}", json={"name": "x"}).status_code == 404
    assert "cron.update" in env.audit_file.read_text() and "Neu" not in env.audit_file.read_text().replace("cron.update", "")


def test_system_jobs_need_explicit_confirmation(env):
    n = len(writes(env.dash))
    assert env.put(f"{CRON}/schedules/{SYSTEM_ID}", json={"schedule": "5 4 * * *"}).status_code == 409
    assert env.post(f"{CRON}/schedules/{SYSTEM_ID}/trigger").status_code == 409
    assert env.request("DELETE", f"{CRON}/schedules/{SYSTEM_ID}").status_code == 409
    assert len(writes(env.dash)) == n
    assert env.put(f"{CRON}/schedules/{SYSTEM_ID}", json={"schedule": "5 4 * * *", "confirm_system": True}).status_code == 200
    assert "confirm_system" not in writes(env.dash)[-1][3]["updates"]
    assert env.post(f"{CRON}/schedules/{SYSTEM_ID}/trigger", json={"confirm_system": True}).json()["last_run_at"].startswith("2026-10-24T12")
    assert env.post(f"{CRON}/schedules/{SYSTEM_ID}/pause").status_code == 200  # Pausieren ist harmlos und braucht keine Bestätigung


def test_pause_resume_trigger_delete_and_audit(env):
    assert env.post(f"{CRON}/schedules/{AGENT_ID}/pause").json()["state"] == "paused"
    assert env.post(f"{CRON}/schedules/{AGENT_ID}/resume").json()["state"] == "scheduled"
    assert env.post(f"{CRON}/schedules/{AGENT_ID}/trigger").json()["last_status"] == "ok"
    assert env.post(f"{CRON}/schedules/{AGENT_ID}/explode").status_code == 422
    assert env.request("DELETE", f"{CRON}/schedules/{AGENT_ID}").json() == {"ok": True}
    assert env.get(f"{CRON}/schedules/{AGENT_ID}").status_code == 404
    lines = [json.loads(x) for x in env.audit_file.read_text().splitlines() if "cron." in x]
    assert [x["action"] for x in lines][-4:] == ["cron.pause", "cron.resume", "cron.trigger", "cron.delete"]
    assert all(x["detail"] == {"job": AGENT_ID, "profile": "alpha"} for x in lines[-4:])


def test_upstream_errors_pass_on(env):
    env.dash.state.fail = {"trigger": 409, "pause": 500}
    r = env.post(f"{CRON}/schedules/{AGENT_ID}/trigger")
    assert r.status_code == 502 and "409" in r.json()["detail"]  # das Dashboard meldet 409 (läuft schon), BFF macht daraus 502 mit Grund
    assert env.post(f"{CRON}/schedules/{AGENT_ID}/pause").status_code == 502


def test_blueprint_instantiate_ends_paused(env):
    r = env.post(f"{CRON}/blueprints", json={"blueprint": "morning-brief", "values": {"time": "08:00", "deliver": "local"}})
    assert r.status_code == 200 and r.json()["state"] == "paused" and r.json()["enabled"] is False
    paths = [c[1] for c in writes(env.dash)]
    assert paths[-2:] == ["/api/cron/blueprints/instantiate", f"/api/cron/jobs/{r.json()['id']}/pause"]
    assert env.post(f"{CRON}/blueprints", json={"blueprint": "gibts-nicht", "values": {}}).status_code == 404
    env.dash.state.fail = {"pause": 500}
    r = env.post(f"{CRON}/blueprints", json={"blueprint": "morning-brief", "values": {}})
    # Pausieren scheitert: der eben angelegte Job wird wieder entfernt, es bleibt nichts Aktives zurück
    assert r.status_code == 502 and "entfernt" in r.json()["detail"] and "aktiv" not in r.json()["detail"]
    assert writes(env.dash)[-1][:2] == ("DELETE", f"/api/cron/jobs/{[c for c in writes(env.dash) if c[1].endswith('/pause')][-1][1].split('/')[-2]}")
    env.dash.state.fail = {"pause": 500, "delete": 500}
    r = env.post(f"{CRON}/blueprints", json={"blueprint": "morning-brief", "values": {}})
    assert r.status_code == 502 and "aktiv" in r.json()["detail"]  # auch das Entfernen scheitert: der Job wird mit Kennung gemeldet
    assert env.post(f"{CRON}/blueprints", json={"blueprint": "../x", "values": {}}).status_code == 422


def test_writes_need_fresh_login_and_reading_does_not(env):
    env.app.state.sessions.get(env.cookies.get(SESSION_COOKIE)).auth_time = 0
    assert env.get(f"{CRON}/schedules").status_code == 200
    n = len(writes(env.dash))
    for r in (env.post(f"{CRON}/schedules", json={"schedule": "30m", "prompt": "x"}), env.put(f"{CRON}/schedules/{AGENT_ID}", json={"name": "x"}), env.post(f"{CRON}/schedules/{AGENT_ID}/pause"),
              env.request("DELETE", f"{CRON}/schedules/{AGENT_ID}"), env.post(f"{CRON}/blueprints", json={"blueprint": "morning-brief"})):
        assert r.status_code == 401 and r.json()["detail"]["code"] == "step_up_required"
    assert len(writes(env.dash)) == n


def test_anonymous_is_rejected(env):
    env.cookies.clear()
    assert env.get(f"{CRON}/schedules").status_code == 401 and env.get("/bff/h/ct/_logs").status_code == 401


# --- Logs ----------------------------------------------------------------------------------------------
def test_logs_filters_are_passed_and_content_is_redacted(env):
    r = env.get("/bff/h/ct/_logs", params={"profile": "alpha", "lines": 100, "level": "INFO"}).json()
    assert r["redacted"] is True and r["file"] == "agent" and len(r["lines"]) == 4
    text = "\n".join(r["lines"])
    assert "pw@" not in text and "token=1" not in text and "https://example.com/pfad" in text
    assert env.dash.state.calls[-1][2] == {"file": "agent", "lines": "100", "level": "INFO", "component": "all", "profile": "alpha"}
    only = env.get("/bff/h/ct/_logs", params={"level": "ERROR"}).json()["lines"]
    assert len(only) == 1 and "ERROR" in only[0]
    assert len(env.get("/bff/h/ct/_logs", params={"search": "terminal"}).json()["lines"]) == 1
    assert env.dash.state.calls[-1][2]["search"] == "terminal"
    assert len(env.get("/bff/h/ct/_logs", params={"component": "cron"}).json()["lines"]) == 1


def test_logs_validation_and_limits(env):
    for params in ({"lines": 0}, {"lines": 501}, {"level": "LAUT"}, {"component": "x"}, {"file": "../etc"}, {"file": "A"}, {"search": "a\nb"}, {"search": "x" * 201}, {"profile": "../x"}):
        assert env.get("/bff/h/ct/_logs", params=params).status_code == 422, params
    assert env.get("/bff/h/ct/_logs", params={"file": "unbekannt"}).status_code == 502  # das Dashboard lehnt ab, der Grund bleibt


def test_log_view_truncates_to_the_byte_limit_and_keeps_the_newest():
    from app.cron import log_view
    lines = [f"zeile {i:05d} " + "x" * 90 + "\n" for i in range(5000)]
    out = log_view({"file": "agent", "lines": lines}, cap=10_000)
    assert out["truncated"] is True and out["lines"][-1].startswith("zeile 04999")
    assert sum(len(x.encode()) + 1 for x in out["lines"]) <= 10_000
    assert log_view({"lines": []})["lines"] == []
    with pytest.raises(ValueError):
        log_view({"lines": "kein array"})


def test_unregistered_profile_is_refused_before_any_dashboard_call(env):
    before = len(env.dash.state.calls)
    assert env.get("/bff/h/ct/_cron/ghost/schedules").status_code == 404
    assert env.post("/bff/h/ct/_cron/ghost/schedules", json={"schedule": "30m", "prompt": "x"}).status_code == 404
    assert env.get("/bff/h/ct/_cron/ghost/skill-names").status_code == 404
    assert len(env.dash.state.calls) == before  # nichts erreichte das Dashboard
    assert env.get(f"{CRON}/schedules").status_code == 200  # registriertes Profil bleibt nutzbar
