"""Sitzungen verwalten (Punkt 9). Schranken siehe tests/test_hermes_sessions.py.

Nicht durchgereicht: Import (fremde Verläufe einschleusen), `owner-backfill` (Migration), Umbenennen/Fork/Liste laufen schon über die Agent-API.
"""
from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator

from ..auth import User, current_user, fresh_user
from .agents import Tgt, upstream
from .dashboard import Dash, audit

router = APIRouter(prefix="/bff/h/{host}/{runtime}/{agent}", dependencies=[Depends(current_user)])

SID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")


def _sid(v: str) -> str:
    if not SID.match(v) or ".." in v:
        raise ValueError("Sitzungs-ID: nur Buchstaben, Ziffern und _ . : -")
    return v


def _limit(request: Request, user: User, what: str) -> None:
    request.app.state.limiter.check(f"{user.id}:{what}")


async def _stats(dash: Dash, agent: str) -> dict[str, Any]:
    b = await upstream(dash.request("GET", "/api/sessions/stats", params={"profile": agent}))
    if not isinstance(b, dict) or not isinstance(b.get("total"), int) or not isinstance(b.get("messages"), int):
        raise HTTPException(502, "Das Dashboard liefert die Sitzungsstatistik in unbekannter Form")
    return b


@router.get("/hermes-sessions/stats")
async def stats(target: Tgt, dash: Dash):
    b = await _stats(dash, target.agent.id)
    by = b.get("by_source")
    return {"total": b["total"], "active_store": b.get("active_store", b["total"]), "archived": b.get("archived", 0), "messages": b["messages"],
            "by_source": {str(k): v for k, v in by.items() if isinstance(v, int)} if isinstance(by, dict) else {}}


class PruneIn(BaseModel):
    model_config = {"extra": "forbid"}
    older_than_days: float = Field(ge=1, le=3650)  # ge=1: 0 Tage träfe jede beendete Sitzung
    source: str | None = Field(default=None, max_length=50)


class PruneRun(PruneIn):
    confirm_count: int = Field(ge=0)


async def _preview(dash: Dash, agent: str, req: PruneIn) -> dict[str, Any]:
    body = {"older_than_days": req.older_than_days, "dry_run": True, "profile": agent, **({"source": req.source} if req.source else {})}
    b = await upstream(dash.request("POST", "/api/sessions/prune", body=body))
    if not isinstance(b, dict) or not isinstance(b.get("matched"), int):
        raise HTTPException(502, "Das Dashboard liefert die Aufräum-Vorschau in unbekannter Form")
    rows = b.get("sessions") if isinstance(b.get("sessions"), list) else []
    return {"matched": b["matched"], "skipped_open": int(b.get("skipped_open") or 0),
            "sample": [{"id": r.get("id"), "title": str(r.get("title") or "")[:120]} for r in rows[:20] if isinstance(r, dict)]}


@router.post("/hermes-sessions/prune/preview")
async def prune_preview(target: Tgt, dash: Dash, req: PruneIn):
    return await _preview(dash, target.agent.id, req)


@router.post("/hermes-sessions/prune")
async def prune(request: Request, target: Tgt, dash: Dash, req: PruneRun, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-sessions")
    pre = await _preview(dash, target.agent.id, req)
    if req.confirm_count != pre["matched"]:
        raise HTTPException(422, f"Aufräumen: die Vorschau zeigt {pre['matched']} Sitzungen, die eingegebene Zahl stimmt nicht")
    if pre["matched"] == 0:
        return {"ok": True, "removed": 0}
    before = (await _stats(dash, target.agent.id))["total"]
    body = {"older_than_days": req.older_than_days, "profile": target.agent.id, **({"source": req.source} if req.source else {})}
    out = await upstream(dash.request("POST", "/api/sessions/prune", body=body))
    removed = out.get("removed") if isinstance(out, dict) else None
    # shortcut: Gegenlesen prüft nur "Gesamtzahl gesunken", nicht die exakte Differenz (Kompressionsketten zählen anders); bei Bedarf schärfen.
    if not isinstance(removed, int) or (removed > 0 and (await _stats(dash, target.agent.id))["total"] >= before):
        raise HTTPException(502, "Das Dashboard hat die Sitzungen nicht gelöscht")
    audit(request, user, "sessions.prune", target, older_than_days=req.older_than_days, removed=removed)
    return {"ok": True, "removed": removed, "skipped_open": int(out.get("skipped_open") or 0)}


class BulkIn(BaseModel):
    model_config = {"extra": "forbid"}
    ids: list[str] = Field(min_length=1, max_length=500)
    confirm_count: int = Field(ge=0)

    @field_validator("ids")
    @classmethod
    def _ids(cls, v: list[str]) -> list[str]:
        return list(dict.fromkeys(_sid(i) for i in v))


@router.post("/hermes-sessions/bulk-delete")
async def bulk_delete(request: Request, target: Tgt, dash: Dash, req: BulkIn, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-sessions")
    if req.confirm_count != len(req.ids):
        raise HTTPException(422, f"Löschen: {len(req.ids)} Sitzungen ausgewählt, die eingegebene Zahl stimmt nicht")
    before = (await _stats(dash, target.agent.id))["total"]
    out = await upstream(dash.request("POST", "/api/sessions/bulk-delete", body={"ids": req.ids, "profile": target.agent.id}))
    deleted = out.get("deleted") if isinstance(out, dict) else None
    skipped = out.get("skipped_active") if isinstance(out, dict) and isinstance(out.get("skipped_active"), list) else []
    if not isinstance(deleted, int) or (deleted > 0 and (await _stats(dash, target.agent.id))["total"] >= before):
        raise HTTPException(502, "Das Dashboard hat die Sitzungen nicht gelöscht")
    audit(request, user, "sessions.bulk_delete", target, requested=len(req.ids), deleted=deleted, skipped_active=len(skipped))
    return {"ok": True, "deleted": deleted, "skipped_active": [str(s) for s in skipped]}


async def _empty_count(dash: Dash, agent: str) -> int:
    b = await upstream(dash.request("GET", "/api/sessions/empty/count", params={"profile": agent}))
    if not isinstance(b, dict) or not isinstance(b.get("count"), int):
        raise HTTPException(502, "Das Dashboard liefert die Zahl leerer Sitzungen in unbekannter Form")
    return b["count"]


@router.get("/hermes-sessions/empty")
async def empty_count(target: Tgt, dash: Dash):
    return {"count": await _empty_count(dash, target.agent.id)}


@router.delete("/hermes-sessions/empty")
async def empty_delete(request: Request, target: Tgt, dash: Dash, confirm: str = Query(default=""), user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-sessions")
    n = await _empty_count(dash, target.agent.id)
    if confirm != str(n):
        raise HTTPException(422, f"Löschen: es gibt {n} leere Sitzungen, die eingegebene Zahl stimmt nicht")
    out = await upstream(dash.request("DELETE", "/api/sessions/empty", params={"profile": target.agent.id}))
    deleted = out.get("deleted") if isinstance(out, dict) else None
    if not isinstance(deleted, int) or (deleted > 0 and await _empty_count(dash, target.agent.id) >= n):
        raise HTTPException(502, "Das Dashboard hat die leeren Sitzungen nicht gelöscht")
    audit(request, user, "sessions.empty_delete", target, deleted=deleted)
    return {"ok": True, "deleted": deleted}


@router.get("/hermes-sessions/{session_id}/export")
async def export_one(session_id: str, target: Tgt, dash: Dash):
    try:
        sid = _sid(session_id)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    b = await upstream(dash.request("GET", f"/api/sessions/{sid}/export", params={"profile": target.agent.id}, missing="Sitzung nicht gefunden"))
    if not isinstance(b, dict) or not isinstance(b.get("messages"), list):
        raise HTTPException(502, "Das Dashboard liefert die Sitzung in unbekannter Form")
    return b
