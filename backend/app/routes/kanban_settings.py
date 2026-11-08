"""Etappe 2 der Abdeckung: Kanban-Einstellungen. Orchestrierung, Profil-Beschreibungen, Heimatkanäle je Aufgabe, Anzeige-Einstellungen,
Spalten (Workflow) und die Modellauswahl, soweit das Kanban-Plugin des Dashboards sie anbietet.

Schranken: Schreiben (Orchestrierung, Beschreibung, automatisches Beschreiben, Heimatkanal) nur mit frischer Anmeldung und Rate-Limit; automatisches
Beschreiben verbraucht Modell-Tokens und überschreibt Beschreibungen, darum nur mit `confirm`. Profilnamen nur aus der Liste des Dashboards, nie frei.
Orchestrierung wird nach dem Schreiben zurückgelesen. Serverpfade (`primary_path` der Projekte, Heimatkanal-IDs) verlassen das BFF nicht.
Weiterhin nicht durchgereicht: hartes Löschen von Boards und Aufgaben.
"""
from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from pydantic import Field

from ..auth import User, current_user, fresh_user
from ..dashboard_ops import clip
from ._dash import dash
from .kanban import HostId, Strict, TaskId, BoardQ, _rec

router = APIRouter(prefix="/bff/h/{host}/_kanban", dependencies=[Depends(current_user)])
P = "/api/plugins/kanban"
NAME = r"^[a-z0-9][a-z0-9_-]{0,63}$"
Profile = Annotated[str, Path(pattern=NAME)]
Platform = Annotated[str, Path(pattern=r"^[a-z][a-z0-9_]{0,31}$")]
Opt = Annotated[str, Field(pattern=r"^([a-z0-9][a-z0-9_-]{0,63})?$")]  # leer = Überschreibung löschen


def _limit(request: Request, user: User, what: str) -> None:
    request.app.state.limiter.check(f"{user.id}:{what}")


def _b(v: Any) -> bool:
    return bool(v) if isinstance(v, bool) else False


def _s(v: Any, n: int = 200) -> str:
    return clip(v, n) if isinstance(v, str) else ""


def _orch(b: Any) -> dict[str, Any]:
    if not isinstance(b, dict):
        raise HTTPException(502, "Das Dashboard liefert die Orchestrierung in unbekannter Form")
    out: dict[str, Any] = {k: _s(b.get(k), 64) for k in ("orchestrator_profile", "default_assignee", "resolved_orchestrator_profile", "resolved_default_assignee", "active_profile")}
    out |= {k: _b(b.get(k)) for k in ("auto_decompose", "auto_promote_children")}
    return out


@router.get("/settings")
async def settings(request: Request, host: HostId):
    """Alles, was die Einstellungsansicht braucht, in einer Antwort. Einzelne Teile dürfen fehlen (ältere Hermes-Version): dann `null` mit Hinweis."""
    parts: dict[str, Any] = {}
    notes: dict[str, str] = {}
    for key, path in (("config", "/config"), ("orchestration", "/orchestration"), ("workflow", "/workflow"), ("profiles", "/profiles")):
        try:
            parts[key] = await dash(request, host, "GET", P + path)
        except HTTPException as e:
            parts[key], notes[key] = None, str(e.detail)[:200]
    cfg = parts["config"] if isinstance(parts["config"], dict) else None
    wf = parts["workflow"] if isinstance(parts["workflow"], dict) else None
    roster = parts["profiles"].get("profiles") if isinstance(parts["profiles"], dict) else None
    return {
        "config": {"default_tenant": _s(cfg.get("default_tenant"), 64), "lane_by_profile": _b(cfg.get("lane_by_profile")),
                   "include_archived_by_default": _b(cfg.get("include_archived_by_default")), "render_markdown": _b(cfg.get("render_markdown"))} if cfg else None,
        "orchestration": _orch(parts["orchestration"]) if parts["orchestration"] is not None else None,
        "columns": [{"key": _s(c.get("key"), 40), "label": _s(c.get("label") or c.get("key"), 60)}
                    for c in (wf.get("columns") or [])[:20] if isinstance(c, dict)] if wf and isinstance(wf.get("columns"), list) else None,
        "profiles": [{"name": _s(p.get("name"), 64), "is_default": _b(p.get("is_default")), "model": _s(p.get("model"), 80), "provider": _s(p.get("provider"), 40),
                      "description": _s(p.get("description"), 300), "description_auto": _b(p.get("description_auto")),
                      "skill_count": p["skill_count"] if isinstance(p.get("skill_count"), int) else None}
                     for p in roster[:100] if isinstance(p, dict) and isinstance(p.get("name"), str)] if isinstance(roster, list) else None,
        "notes": notes,
    }


class OrchIn(Strict):
    orchestrator_profile: Opt | None = None
    default_assignee: Opt | None = None
    auto_decompose: bool | None = None
    auto_promote_children: bool | None = None


@router.put("/orchestration")
async def set_orchestration(request: Request, host: HostId, req: OrchIn, user: User = Depends(fresh_user)):
    _limit(request, user, "kanban-settings")
    body = req.model_dump(exclude_none=True)
    if not body:
        raise HTTPException(422, "Keine Änderung angegeben")
    got = _orch(await dash(request, host, "PUT", P + "/orchestration", body=body))
    for k, v in body.items():  # zurücklesen: stimmt der gespeicherte Stand?
        if got.get(k) != v:
            raise HTTPException(502, "Das Dashboard hat die Orchestrierung nicht übernommen")
    _rec(request, user, "kanban.orchestration", host, **body)
    return got


class DescIn(Strict):
    description: Annotated[str, Field(max_length=300)]


@router.patch("/profiles/{profile}")
async def set_description(request: Request, host: HostId, profile: Profile, req: DescIn, user: User = Depends(fresh_user)):
    _limit(request, user, "kanban-settings")
    b = await dash(request, host, "PATCH", f"{P}/profiles/{profile}", body={"description": req.description.strip()})
    if not isinstance(b, dict) or b.get("ok") is not True:
        raise HTTPException(502, "Das Dashboard hat die Beschreibung nicht übernommen")
    _rec(request, user, "kanban.profile_description", host, profile=profile, length=len(req.description.strip()))
    return {"ok": True, "profile": profile, "description": _s(b.get("description"), 300)}


class AutoIn(Strict):
    confirm: bool = False
    overwrite: bool = False


@router.post("/profiles/{profile}/describe-auto")
async def describe_auto(request: Request, host: HostId, profile: Profile, req: AutoIn, user: User = Depends(fresh_user)):
    """Lässt das Hilfsmodell die Beschreibung schreiben: kostet Tokens, darum nur mit `confirm`. Nicht-OK ist hier Inhalt, kein HTTP-Fehler."""
    _limit(request, user, "kanban-settings-auto")
    if not req.confirm:
        raise HTTPException(422, "Das automatische Beschreiben verbraucht Modell-Tokens. Bitte bestätigen.")
    b = await dash(request, host, "POST", f"{P}/profiles/{profile}/describe-auto", body={"overwrite": req.overwrite})
    if not isinstance(b, dict):
        raise HTTPException(502, "Das Dashboard liefert das Ergebnis in unbekannter Form")
    _rec(request, user, "kanban.profile_describe_auto", host, profile=profile, overwrite=req.overwrite, ok=_b(b.get("ok")))
    return {"ok": _b(b.get("ok")), "profile": profile, "reason": _s(b.get("reason"), 300) or None, "description": _s(b.get("description"), 300)}


# ---- Heimatkanäle je Aufgabe: nur Plattform und Zustand, nie Chat-IDs ----
@router.get("/home-channels")
async def home_channels(request: Request, host: HostId, board: BoardQ = None, task_id: Annotated[str | None, Query(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")] = None):
    params = {k: v for k, v in (("board", board), ("task_id", task_id)) if v}
    b = await dash(request, host, "GET", P + "/home-channels", params=params or None)
    rows = b.get("home_channels") if isinstance(b, dict) else None
    if not isinstance(rows, list):
        raise HTTPException(502, "Das Dashboard liefert die Heimatkanäle in unbekannter Form")
    return {"home_channels": [{"platform": _s(r.get("platform"), 32), "name": _s(r.get("name"), 60) or "Home", "subscribed": _b(r.get("subscribed"))}
                              for r in rows[:30] if isinstance(r, dict) and isinstance(r.get("platform"), str)]}


async def _sub(request: Request, host: str, method: str, task: str, platform: str, board: str | None, user: User) -> dict[str, Any]:
    _limit(request, user, "kanban-settings")
    b = await dash(request, host, method, f"{P}/tasks/{task}/home-subscribe/{platform}", params={"board": board} if board else None)
    if not isinstance(b, dict) or b.get("ok") is not True:
        raise HTTPException(502, "Das Dashboard hat die Benachrichtigung nicht übernommen")
    _rec(request, user, "kanban.home_subscribe" if method == "POST" else "kanban.home_unsubscribe", host, task=task, platform=platform)
    return {"ok": True, "task_id": task, "platform": platform}


@router.post("/tasks/{task}/home-subscribe/{platform}")
async def subscribe(request: Request, host: HostId, task: TaskId, platform: Platform, board: BoardQ = None, user: User = Depends(fresh_user)):
    return await _sub(request, host, "POST", task, platform, board, user)


@router.delete("/tasks/{task}/home-subscribe/{platform}")
async def unsubscribe(request: Request, host: HostId, task: TaskId, platform: Platform, board: BoardQ = None, user: User = Depends(fresh_user)):
    return await _sub(request, host, "DELETE", task, platform, board, user)


# ---- Modelle und Projekte (nur Lesen, für Auswahllisten) ----
@router.get("/model-options")
async def model_options(request: Request, host: HostId):
    b = await dash(request, host, "GET", P + "/model-options")
    rows = b.get("providers") if isinstance(b, dict) else None
    if not isinstance(rows, list):
        raise HTTPException(502, "Das Dashboard liefert die Modelle in unbekannter Form")
    return {"providers": [{"slug": _s(r.get("slug"), 40), "label": _s(r.get("label"), 60), "models": [_s(m, 100) for m in (r.get("models") or [])[:200] if isinstance(m, str)]}
                          for r in rows[:50] if isinstance(r, dict)]}


@router.get("/projects")
async def projects(request: Request, host: HostId):
    b = await dash(request, host, "GET", P + "/projects")
    rows = b.get("projects") if isinstance(b, dict) else None
    if not isinstance(rows, list):
        raise HTTPException(502, "Das Dashboard liefert die Projekte in unbekannter Form")
    return {"projects": [{"id": _s(r.get("id"), 64), "slug": _s(r.get("slug"), 64), "name": _s(r.get("name"), 100)} for r in rows[:100] if isinstance(r, dict)]}  # ohne primary_path
