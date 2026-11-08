"""Zeitpläne (Cron) und Logs über das Dashboard: Eingabemodelle und Antwortformen.

Formen belegt durch backend/tests/fixtures/cron_dashboard.json (echte, bereinigte Dashboard-Antworten).
Job-Antworten werden auf bekannte Felder reduziert: `hermes_home` (Pfad), `origin` und Ausführungs-Interna bleiben draußen.
"""
from __future__ import annotations

import re
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from .dashboard_ops import redact

NO_CONTROL = r"^[^\x00-\x1f\x7f]*$"
NO_NULL = r"^[^\x00]*$"  # mehrzeilig erlaubt (Skript), nur NUL verboten
Line = Annotated[str, StringConstraints(max_length=200, pattern=NO_CONTROL)]
SKILL_RE = r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$"
Skills = Annotated[list[Annotated[str, StringConstraints(pattern=SKILL_RE)]], Field(max_length=30)]
Repeat = Annotated[int, Field(ge=1, le=1_000_000)]
JOB_RE = r"^[a-f0-9]{12}$"
LOG_LEVELS = ("ALL", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")
LOG_FILES = ("agent", "errors", "gateway", "gui", "desktop")  # LOG_FILES in hermes_cli/logs.py; unbekannte Namen lehnt das Dashboard mit 400 ab
LOG_COMPONENTS = ("all", "gateway", "agent", "tools", "cli", "cron", "gui")  # COMPONENT_PREFIXES in hermes_logging.py
LOG_MAX_LINES = 500  # so viele liefert das Dashboard höchstens je Anfrage
LOG_MAX_BYTES = 256 * 1024


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class JobFields(Strict):
    name: Line | None = None
    schedule: Annotated[str, StringConstraints(min_length=1, max_length=200, pattern=NO_CONTROL)] | None = None
    prompt: Annotated[str, StringConstraints(max_length=20000)] | None = None
    deliver: Annotated[str, StringConstraints(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9][A-Za-z0-9:_.@#-]*$")] | None = None
    repeat: Repeat | None = None
    skills: Skills | None = None
    model: Line | None = None
    provider: Line | None = None


class JobCreate(JobFields):
    schedule: Annotated[str, StringConstraints(min_length=1, max_length=200, pattern=NO_CONTROL)]
    prompt: Annotated[str, StringConstraints(min_length=1, max_length=20000)]
    script: Annotated[str, StringConstraints(min_length=1, max_length=20000, pattern=NO_NULL)] | None = None  # Skript-Job: läuft ohne Agent
    no_agent: bool = False
    confirm_system: bool = False

    def creates_system(self) -> bool:
        return self.no_agent or self.script is not None

    @model_validator(mode="after")
    def _script_required(self):
        if self.no_agent and self.script is None:
            raise ValueError("Ein Job ohne Agent braucht ein Skript")
        return self


class JobUpdate(JobFields):
    """Nur geänderte Felder senden. `repeat_unlimited` hebt die Begrenzung auf; `confirm_system` ist für Skript-Jobs Pflicht."""
    repeat_unlimited: bool = False
    confirm_system: bool = False

    def updates(self) -> dict[str, Any]:
        out = self.model_dump(exclude_none=True, exclude={"repeat_unlimited", "confirm_system"})
        if self.repeat_unlimited:
            out["repeat"] = None
        return out


class Instantiate(Strict):
    blueprint: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$")
    values: dict[Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_]{1,50}$")], Annotated[str, StringConstraints(max_length=2000)]] = Field(default_factory=dict, max_length=20)


class Confirmed(Strict):
    confirm_system: bool = False


def is_system(job: dict[str, Any]) -> bool:
    return bool(job.get("script") or job.get("no_agent"))


def _s(v: Any, limit: int = 200) -> str | None:
    return v[:limit] if isinstance(v, str) else None


def _stamp(v: Any) -> str | None:
    return v if isinstance(v, str) and len(v) <= 40 else None


def job_view(j: dict[str, Any]) -> dict[str, Any]:
    sched = j.get("schedule") if isinstance(j.get("schedule"), dict) else {}
    rep = j.get("repeat") if isinstance(j.get("repeat"), dict) else {}
    ex = j.get("latest_execution") if isinstance(j.get("latest_execution"), dict) else {}
    err = j.get("last_error") or ex.get("error")
    skills = j.get("skills") if isinstance(j.get("skills"), list) else []
    return {
        "id": _s(j.get("id"), 64), "name": _s(j.get("name")) or "", "prompt": j.get("prompt") if isinstance(j.get("prompt"), str) else "",
        "skills": [s for s in skills if isinstance(s, str)][:30], "model": _s(j.get("model")), "provider": _s(j.get("provider")),
        "system": is_system(j), "script": _s(j.get("script")), "no_agent": bool(j.get("no_agent")),
        "schedule": {"kind": _s(sched.get("kind"), 20), "expr": _s(sched.get("expr")), "minutes": sched.get("minutes") if isinstance(sched.get("minutes"), int) else None,
                     "display": _s(sched.get("display")) or _s(j.get("schedule_display"))},
        "repeat": {"times": rep.get("times") if isinstance(rep.get("times"), int) else None, "completed": rep.get("completed") if isinstance(rep.get("completed"), int) else 0},
        "enabled": bool(j.get("enabled", True)), "state": _s(j.get("state"), 30) or "unknown", "paused_reason": _s(j.get("paused_reason")),
        "next_run_at": _stamp(j.get("next_run_at")), "last_run_at": _stamp(j.get("last_run_at")), "last_status": _s(j.get("last_status"), 30),
        "last_error": redact(err)[:500] if isinstance(err, str) and err else None,
        "failure_streak": j.get("failure_streak") if isinstance(j.get("failure_streak"), int) else 0,
        "deliver": _s(j.get("deliver")) or "local",
        "latest": {"status": _s(ex.get("status"), 30), "started_at": _stamp(ex.get("started_at")), "finished_at": _stamp(ex.get("finished_at"))} if ex else None,
    }


def jobs_view(body: Any) -> list[dict[str, Any]]:
    rows = body.get("jobs") if isinstance(body, dict) else body
    return [job_view(j) for j in rows if isinstance(j, dict) and isinstance(j.get("id"), str)] if isinstance(rows, list) else []


def run_view(r: dict[str, Any]) -> dict[str, Any]:
    """Ein Lauf: Zeit, Dauer, Kurzfassung. Der Titel trägt den Status (`COMPLETED · …`), die Vorschau den Anfang der Ausgabe."""
    start, end = r.get("started_at"), r.get("ended_at")
    num = lambda v: v if isinstance(v, (int, float)) and not isinstance(v, bool) else None
    title = r.get("title") if isinstance(r.get("title"), str) else ""
    status = title.split(" · ", 1)[0] if " · " in title and title.split(" · ", 1)[0].isupper() else None
    return {"id": _s(r.get("id"), 200), "status": _s(status, 30), "started_at": num(start), "ended_at": num(end),
            "duration_s": round(end - start, 1) if num(start) is not None and num(end) is not None and end >= start else None,
            "preview": redact(r.get("preview") if isinstance(r.get("preview"), str) else "")[:600], "active": bool(r.get("is_active"))}


def runs_view(body: Any) -> list[dict[str, Any]]:
    rows = body.get("runs") if isinstance(body, dict) else None
    return [run_view(r) for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


def targets_view(body: Any) -> list[dict[str, Any]]:
    rows = body.get("targets") if isinstance(body, dict) else None
    return [{"id": r["id"], "name": _s(r.get("name")) or r["id"], "ready": bool(r.get("home_target_set"))}
            for r in rows if isinstance(r, dict) and isinstance(r.get("id"), str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9:_.@#-]{0,199}", r["id"])] if isinstance(rows, list) else []


def blueprints_view(body: Any) -> list[dict[str, Any]]:
    rows = body.get("blueprints") if isinstance(body, dict) else None
    out = []
    for b in rows if isinstance(rows, list) else []:
        if not isinstance(b, dict) or not isinstance(b.get("key"), str):
            continue
        fields = [{"name": _s(f.get("name"), 50), "type": _s(f.get("type"), 20), "label": _s(f.get("label"), 200), "default": _s(str(f.get("default", "")), 500),
                   "options": [o for o in f.get("options", []) if isinstance(o, str)][:50], "optional": bool(f.get("optional")), "help": _s(f.get("help"), 300)}
                  for f in b.get("fields", []) if isinstance(f, dict) and isinstance(f.get("name"), str)]
        out.append({"key": b["key"][:100], "title": _s(b.get("title")) or b["key"], "description": _s(b.get("description"), 500) or "", "category": _s(b.get("category"), 50),
                    "schedule_human": _s(b.get("scheduleHuman")), "fields": fields})
    return out


def log_view(body: Any, cap: int = LOG_MAX_BYTES) -> dict[str, Any]:
    lines = body.get("lines") if isinstance(body, dict) else None
    if not isinstance(lines, list):
        raise ValueError("unbekannte Form")
    text = redact("\n".join(str(x).rstrip("\n") for x in lines))
    out = text.split("\n") if text else []
    cut = False
    while out and sum(len(x.encode()) + 1 for x in out) > cap:
        out = out[max(1, len(out) // 20):]  # älteste zuerst; in Schritten, damit die Schleife kurz bleibt
        cut = True
    return {"file": _s(body.get("file"), 30) or "agent", "lines": out, "redacted": True, "truncated": cut or len(lines) >= LOG_MAX_LINES}
