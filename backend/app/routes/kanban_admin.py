"""Kanban in der Tiefe (Punkt 9). Schranken siehe tests/test_kanban_admin.py."""
from __future__ import annotations

import re
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import Field

from ..auth import User, current_user, fresh_user, is_fresh
from ._dash import dash
from .kanban import MISSING, NO_TASK, SLUG, TASK, HostId, Slug, Strict, TaskId, _bp, BoardQ, _rec

router = APIRouter(prefix="/bff")
P = "/api/plugins/kanban"
SEV = r"^(warning|error|critical)$"


def _limit(request: Request, user: User, what: str) -> None:
    request.app.state.limiter.check(f"{user.id}:{what}")


def _s(v: Any, n: int) -> str:
    return v[:n] if isinstance(v, str) else ""


def _i(v: Any) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def _rows(v: Any) -> list[dict[str, Any]]:
    return [x for x in v if isinstance(x, dict)] if isinstance(v, list) else []


@router.get("/h/{host}/_kanban/diagnostics")
async def diagnostics(request: Request, host: HostId, board: BoardQ = None, severity: Annotated[str | None, Query(pattern=SEV)] = None,
                      user: User = Depends(current_user)):
    raw = await dash(request, host, "GET", f"{P}/diagnostics", params={**(_bp(board) or {}), **({"severity": severity} if severity else {})}, missing=MISSING)
    rows = _rows(raw.get("diagnostics") if isinstance(raw, dict) else None)[:200]
    return {"count": len(rows), "items": [
        {"task_id": _s(r.get("task_id"), 64), "title": _s(r.get("task_title"), 300), "status": _s(r.get("task_status"), 30), "assignee": _s(r.get("task_assignee"), 64),
         "diagnostics": [{"kind": _s(d.get("kind"), 60), "severity": _s(d.get("severity"), 20), "title": _s(d.get("title"), 200), "detail": _s(d.get("detail"), 500)}
                         for d in _rows(r.get("diagnostics"))[:10]]} for r in rows]}


@router.get("/h/{host}/_kanban/workers")
async def workers(request: Request, host: HostId, board: BoardQ = None, user: User = Depends(current_user)):
    raw = await dash(request, host, "GET", f"{P}/workers/active", params=_bp(board), missing=MISSING)
    rows = _rows(raw.get("workers") if isinstance(raw, dict) else None)[:100]
    # ohne worker_pid und claim_lock: Prozessnummern und Sperrschlüssel gehen den Browser nichts an
    return {"count": len(rows), "workers": [
        {"run_id": _i(r.get("run_id")), "task_id": _s(r.get("task_id"), 64), "title": _s(r.get("task_title"), 300), "profile": _s(r.get("profile"), 64),
         "started_at": _i(r.get("started_at")), "last_heartbeat_at": _i(r.get("last_heartbeat_at")), "max_runtime_seconds": _i(r.get("max_runtime_seconds"))} for r in rows]}


@router.get("/h/{host}/_kanban/runs/{run_id}/inspect")
async def inspect_run(request: Request, host: HostId, run_id: int, board: BoardQ = None, user: User = Depends(current_user)):
    raw = await dash(request, host, "GET", f"{P}/runs/{run_id}/inspect", params=_bp(board), missing="Diesen Lauf gibt es nicht")
    if not isinstance(raw, dict):
        raise HTTPException(502, "Das Dashboard liefert den Lauf in unbekannter Form")
    # ohne cmdline und pid: Kommandozeilen können Schlüssel enthalten
    return {"run_id": run_id, "alive": bool(raw.get("alive")), "reason": _s(raw.get("reason"), 200), "status": _s(raw.get("status"), 30),
            "cpu_percent": raw.get("cpu_percent") if isinstance(raw.get("cpu_percent"), (int, float)) else None,
            "memory_rss_bytes": _i(raw.get("memory_rss_bytes")), "num_threads": _i(raw.get("num_threads"))}


class Terminate(Strict):
    confirm: str
    reason: Annotated[str, Field(max_length=200)] = ""


@router.post("/h/{host}/_kanban/runs/{run_id}/terminate")
async def terminate(request: Request, host: HostId, run_id: int, body: Terminate, board: BoardQ = None, user: User = Depends(fresh_user)):
    _limit(request, user, "kanban-admin")
    if body.confirm != str(run_id):
        raise HTTPException(422, "Beenden: die Lauf-Nummer zur Bestätigung eingeben")
    await dash(request, host, "POST", f"{P}/runs/{run_id}/terminate", body={"reason": body.reason or None}, params=_bp(board), missing="Diesen Lauf gibt es nicht")
    back = await dash(request, host, "GET", f"{P}/runs/{run_id}", params=_bp(board), missing="Diesen Lauf gibt es nicht")
    run = back.get("run") if isinstance(back, dict) else None
    if not isinstance(run, dict) or run.get("ended_at") is None:
        raise HTTPException(502, "Das Dashboard hat den Lauf nicht beendet")
    _rec(request, user, "kanban.run.terminate", host, run=run_id)
    return {"ok": True, "run_id": run_id}


@router.post("/h/{host}/_kanban/tasks/{task_id}/estimate")
async def estimate(request: Request, host: HostId, task_id: TaskId, board: BoardQ = None, user: User = Depends(fresh_user)):
    _limit(request, user, "kanban-llm")  # verbraucht Tokens des Hilfsmodells
    raw = await dash(request, host, "POST", f"{P}/tasks/{task_id}/estimate", body={}, params=_bp(board), missing=NO_TASK)
    if not isinstance(raw, dict):
        raise HTTPException(502, "Das Dashboard liefert die Schätzung in unbekannter Form")
    _rec(request, user, "kanban.task.estimate", host, task=task_id)
    return {"ok": bool(raw.get("ok")), "est_tokens": _i(raw.get("est_tokens")), "complexity": _s(raw.get("complexity"), 4),
            "rationale": _s(raw.get("rationale"), 400), "reason": _s(raw.get("reason"), 300), "model": _s(raw.get("model"), 100)}


class Specify(Strict):
    confirm: bool = False


@router.post("/h/{host}/_kanban/tasks/{task_id}/specify")
async def specify(request: Request, host: HostId, task_id: TaskId, body: Specify, board: BoardQ = None, user: User = Depends(fresh_user)):
    _limit(request, user, "kanban-llm")
    if not body.confirm:
        raise HTTPException(422, "Spezifizieren schreibt Titel und Beschreibung der Aufgabe um: confirm=true senden")
    raw = await dash(request, host, "POST", f"{P}/tasks/{task_id}/specify", body={}, params=_bp(board), missing=NO_TASK)
    if not isinstance(raw, dict):
        raise HTTPException(502, "Das Dashboard liefert das Ergebnis in unbekannter Form")
    _rec(request, user, "kanban.task.specify", host, task=task_id)
    return {"ok": bool(raw.get("ok")), "reason": _s(raw.get("reason"), 300), "new_title": _s(raw.get("new_title"), 300)}


class Dispatch(Strict):
    dry_run: bool = True
    confirm_spawn: bool = False
    max: Annotated[int, Field(ge=1, le=8)] = 8


@router.post("/h/{host}/_kanban/dispatch")
async def dispatch(request: Request, host: HostId, body: Dispatch, board: BoardQ = None):
    params = {"dry_run": "true" if body.dry_run else "false", "max": str(body.max), **(_bp(board) or {})}
    user = await current_user(request)
    if not body.dry_run:  # echtes Starten: frische Anmeldung (von Hand geprüft, weil die Vorschau frei bleibt)
        if not is_fresh(request):
            raise HTTPException(401, {"code": "step_up_required", "message": "Bitte erneut anmelden"})
        if not body.confirm_spawn:
            raise HTTPException(422, "Dispatch startet Worker: confirm_spawn=true senden")
        _limit(request, user, "kanban-admin")
    raw = await dash(request, host, "POST", f"{P}/dispatch", params=params, body={}, missing=MISSING)
    if not isinstance(raw, dict):
        raise HTTPException(502, "Das Dashboard liefert das Dispatch-Ergebnis in unbekannter Form")
    if not body.dry_run:
        _rec(request, user, "kanban.dispatch", host, max=body.max)
    ids = lambda v: [x[:64] for x in v if isinstance(x, str)][:50] if isinstance(v, list) else []  # noqa: E731
    return {"dry_run": body.dry_run, "spawned": ids(raw.get("spawned")), "promoted": ids(raw.get("promoted"))}


@router.post("/h/{host}/_kanban/boards/{slug}/switch")
async def switch(request: Request, host: HostId, slug: Slug, user: User = Depends(fresh_user)):
    await dash(request, host, "POST", f"{P}/boards/{slug}/switch", body={}, missing="Dieses Board gibt es nicht")
    cur = await dash(request, host, "GET", f"{P}/boards", missing=MISSING)
    if not isinstance(cur, dict) or cur.get("current") != slug:
        raise HTTPException(502, "Das Dashboard hat das Board nicht gewechselt")
    _rec(request, user, "kanban.board.switch", host, board=slug)
    return {"ok": True, "current": slug}
