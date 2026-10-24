"""Dashboard-Ersatz für Zeitpläne und Logs: `/api/cron/*`, `/api/skills`, `/api/logs` mit den echten Formen (backend/tests/fixtures/cron_dashboard.json).

Zustandsbehaftet: anlegen, ändern, pausieren, fortsetzen, ausführen und löschen wirken auf `app.state.jobs`. `app.state.calls` hält jede
Anfrage (Methode, Pfad, Parameter, Body). Ungültige Zeitpläne antworten wie Hermes mit 400.

Start: uvicorn devtools.mock_cron:app --port 9119
"""
from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request

FIXTURE = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "cron_dashboard.json"
SCHEDULE = re.compile(r"^(every \d+[mhd]|\d+[mhd]|in \d+[mhd]|([\d*/,-]+ ){4}[\w*/,-]+)$")
PROFILES = ("default", "alpha")


def create_mock() -> FastAPI:
    data = json.loads(FIXTURE.read_text("utf-8"))
    app = FastAPI()
    app.state.data = data
    app.state.jobs = {"alpha": {j["id"]: copy.deepcopy(j) for j in data["jobs"]}, "default": {}}
    app.state.calls = []
    app.state.fail = {}  # z. B. {"trigger": 409}: diese Aktion scheitert mit dem Status
    app.state.next_id = 0

    @app.middleware("http")
    async def record(request: Request, call_next):
        body = None
        if request.method in ("POST", "PUT", "DELETE"):
            raw = await request.body()
            body = json.loads(raw) if raw else None
        app.state.calls.append((request.method, request.url.path, dict(request.query_params), body))
        return await call_next(request)

    def store(profile: str | None) -> dict[str, dict[str, Any]]:
        profile = profile or "default"  # ohne ?profile= gilt das Standardprofil
        if profile not in PROFILES:
            raise HTTPException(404, "Profile not found")
        return app.state.jobs[profile]

    def job_of(profile: str | None, job_id: str) -> dict[str, Any]:
        job = store(profile).get(job_id)
        if job is None:
            raise HTTPException(404, "Job not found")
        return job

    def failing(action: str) -> None:
        if app.state.fail.get(action):
            raise HTTPException(app.state.fail[action], f"{action} kaputt")

    def parse(schedule: str) -> dict[str, Any]:
        s = schedule.strip()
        if not SCHEDULE.match(s):
            raise HTTPException(400, f"Invalid schedule '{s}'. Use: '30m', 'every 2h' or a cron expression")
        m = re.match(r"^(?:every )?(\d+)([mhd])$", s)
        if m:
            return {"kind": "interval", "minutes": int(m[1]) * {"m": 1, "h": 60, "d": 1440}[m[2]], "display": f"every {m[1]}{m[2]}"}
        return {"kind": "cron", "expr": s, "display": s}

    @app.get("/api/cron/jobs")
    async def list_jobs(profile: str = "all"):
        return list(store(profile).values())

    @app.get("/api/cron/jobs/{job_id}")
    async def get_job(job_id: str, profile: str | None = None):
        return job_of(profile, job_id)

    @app.get("/api/cron/jobs/{job_id}/runs")
    async def runs(job_id: str, profile: str | None = None, limit: int = 20):
        job_of(profile, job_id)
        rows = [r for r in app.state.data["runs"]["runs"] if f":{job_id}:" in r["id"]]
        return {"runs": rows[:limit], "limit": limit}

    @app.post("/api/cron/jobs")
    async def create(body: dict[str, Any], profile: str | None = None):
        failing("create")
        app.state.next_id += 1
        jid = f"{app.state.next_id:012x}"
        paused = body.get("paused") is True
        job = {"id": jid, "name": body.get("name") or "ohne Namen", "prompt": body.get("prompt", ""), "skills": body.get("skills") or [], "model": body.get("model"),
               "provider": body.get("provider"), "script": None, "no_agent": False, "schedule": parse(str(body["schedule"])),
               "repeat": {"times": body.get("repeat"), "completed": 0}, "enabled": not paused, "state": "paused" if paused else "scheduled",
               "paused_reason": body.get("paused_reason") if paused else None, "next_run_at": None if paused else "2026-10-25T08:00:00+00:00",
               "last_run_at": None, "last_status": None, "last_error": None, "failure_streak": 0, "deliver": body.get("deliver") or "local", "latest_execution": None,
               "hermes_home": "/opt/data/profiles/x", "origin": None}
        store(profile)[jid] = job
        return job

    @app.put("/api/cron/jobs/{job_id}")
    async def update(job_id: str, body: dict[str, Any], profile: str | None = None):
        failing("update")
        job = job_of(profile, job_id)
        for k, v in body["updates"].items():
            job[k] = parse(v) if k == "schedule" else ({"times": v, "completed": job["repeat"]["completed"]} if k == "repeat" else v)
        return job

    def set_state(job: dict[str, Any], paused: bool) -> dict[str, Any]:
        job.update(enabled=not paused, state="paused" if paused else "scheduled", paused_reason=None)
        return job

    @app.post("/api/cron/jobs/{job_id}/pause")
    async def pause(job_id: str, profile: str | None = None):
        failing("pause")
        return set_state(job_of(profile, job_id), True)

    @app.post("/api/cron/jobs/{job_id}/resume")
    async def resume(job_id: str, profile: str | None = None):
        return set_state(job_of(profile, job_id), False)

    @app.post("/api/cron/jobs/{job_id}/trigger")
    async def trigger(job_id: str, profile: str | None = None):
        failing("trigger")
        job = job_of(profile, job_id)
        job.update(last_run_at="2026-10-24T12:00:00+00:00", last_status="ok")
        return job

    @app.delete("/api/cron/jobs/{job_id}")
    async def delete(job_id: str, profile: str | None = None):
        job_of(profile, job_id)
        del store(profile)[job_id]
        return {"ok": True}

    @app.get("/api/cron/delivery-targets")
    async def targets(profile: str | None = None):
        store(profile)
        return app.state.data["targets"]

    @app.get("/api/cron/blueprints")
    async def blueprints(profile: str | None = None):
        store(profile)
        return app.state.data["blueprints"]

    @app.post("/api/cron/blueprints/instantiate")
    async def instantiate(body: dict[str, Any], profile: str = "default"):
        bp = next((b for b in app.state.data["blueprints"]["blueprints"] if b["key"] == body["blueprint"]), None)
        if bp is None:
            raise HTTPException(404, f"Unknown blueprint: {body['blueprint']}")
        return await create({"name": bp["title"], "prompt": bp["description"], "schedule": "every 30m", "deliver": body["values"].get("deliver", "local")}, profile)

    @app.get("/api/skills")
    async def skills(profile: str | None = None):
        store(profile)
        return [{"name": n, "description": "", "category": "x", "enabled": True} for n in ("plan", "codex")]

    @app.get("/api/logs")
    async def logs(file: str = "agent", lines: int = 100, level: str | None = None, component: str | None = None, search: str | None = None, profile: str | None = None):
        if file not in ("agent", "errors", "gateway", "gui", "desktop"):
            raise HTTPException(400, f"Unknown log file: {file}")
        store(profile)
        rows = list(app.state.data["logs"]["lines"])
        order = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]
        if level and level.upper() != "ALL":
            rows = [r for r in rows if any(f" {x} " in r for x in order[order.index(level.upper()):])]
        if component and component != "all":
            rows = [r for r in rows if f"] {component}" in r]
        if search:
            rows = [r for r in rows if search.lower() in r.lower()]
        return {"file": file, "lines": rows[-min(lines, 500):]}

    return app


app = create_mock()
