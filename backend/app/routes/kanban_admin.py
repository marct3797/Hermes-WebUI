"""Kanban in der Tiefe (Punkt 9). Schranken siehe tests/test_kanban_admin.py."""
from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response
from pydantic import Field

from ..adapters import UpstreamError
from ..auth import User, current_user, fresh_user, is_fresh
from ._dash import dash, host_dash
from .agents import to_http
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


class Decompose(Strict):
    confirm: bool = False


@router.post("/h/{host}/_kanban/tasks/{task_id}/decompose")
async def decompose(request: Request, host: HostId, task_id: TaskId, body: Decompose, board: BoardQ = None, user: User = Depends(fresh_user)):
    _limit(request, user, "kanban-llm")  # verbraucht Tokens des Hilfsmodells und legt Kindaufgaben an
    if not body.confirm:
        raise HTTPException(422, "Zerlegen legt Kindaufgaben an und verbraucht Tokens des Hilfsmodells: confirm=true senden")
    raw = await dash(request, host, "POST", f"{P}/tasks/{task_id}/decompose", body={}, params=_bp(board), missing=NO_TASK)
    if not isinstance(raw, dict):
        raise HTTPException(502, "Das Dashboard liefert das Ergebnis in unbekannter Form")
    _rec(request, user, "kanban.task.decompose", host, task=task_id)
    kids = raw.get("child_ids")
    return {"ok": bool(raw.get("ok")), "reason": _s(raw.get("reason"), 300), "fanout": bool(raw.get("fanout")),
            "child_ids": [x[:64] for x in kids if isinstance(x, str)][:50] if isinstance(kids, list) else [],
            "new_title": _s(raw.get("new_title"), 300)}


NO_ATTACHMENT = "Diesen Anhang gibt es nicht"
ATTACH_LIMIT = 25 * 1024 * 1024  # wie das Dashboard: mehr nimmt der Upload dort nicht an


def _att(row: Any) -> dict[str, Any]:
    # ohne stored_path: Serverpfade verlassen den Browser nicht
    r = row if isinstance(row, dict) else {}
    return {"id": _i(r.get("id")), "task_id": _s(r.get("task_id"), 64), "filename": _s(r.get("filename"), 255),
            "size": _i(r.get("size")), "uploaded_by": _s(r.get("uploaded_by"), 64), "created_at": _i(r.get("created_at"))}


@router.get("/h/{host}/_kanban/tasks/{task_id}/attachments")
async def attachments(request: Request, host: HostId, task_id: TaskId, board: BoardQ = None, user: User = Depends(current_user)):
    raw = await dash(request, host, "GET", f"{P}/tasks/{task_id}/attachments", params=_bp(board), missing=NO_TASK)
    rows = raw.get("attachments") if isinstance(raw, dict) else None
    if not isinstance(rows, list):
        raise HTTPException(502, "Das Dashboard liefert die Anhänge in unbekannter Form")
    items = [_att(r) for r in rows[:200] if isinstance(r, dict)]
    return {"task_id": task_id, "count": len(items), "attachments": items}


def _upload_name(v: Any) -> str:
    name = (v or "").split("/")[-1].split("\\")[-1].strip()[:255]
    if not name or "\x00" in (v or ""):
        raise HTTPException(422, "Dateiname fehlt oder ist ungültig")
    return name


@router.post("/h/{host}/_kanban/tasks/{task_id}/attachments", status_code=201)
async def attachments_upload(request: Request, host: HostId, task_id: TaskId, board: BoardQ = None,
                             file: UploadFile = File(...), user: User = Depends(fresh_user)):
    _limit(request, user, "kanban-attachments")
    data = await file.read()
    if len(data) > ATTACH_LIMIT:
        raise HTTPException(413, "Der Anhang ist zu groß (max. 25 MB)")
    name = _upload_name(file.filename)
    try:
        raw = await host_dash(request, host).upload(
            f"{P}/tasks/{task_id}/attachments", filename=name, data=data,
            content_type=file.content_type or "application/octet-stream",
            form={"uploaded_by": user.id}, params=_bp(board), missing=NO_TASK)
    except UpstreamError as e:
        raise to_http(e) from e
    if not isinstance(raw, dict):
        raise HTTPException(502, "Das Dashboard liefert den Anhang in unbekannter Form")
    _rec(request, user, "kanban.attachment.upload", host, task=task_id, name=name, size=len(data))
    return _att(raw)


@router.get("/h/{host}/_kanban/tasks/{task_id}/attachments/{attachment_id}")
async def attachment_download(request: Request, host: HostId, task_id: TaskId, attachment_id: int,
                              board: BoardQ = None, user: User = Depends(current_user)):
    # Dateiname aus der Liste (vom Dashboard), Bytes aus dem Download: so landet kein Serverpfad im Browser
    raw = await dash(request, host, "GET", f"{P}/tasks/{task_id}/attachments", params=_bp(board), missing=NO_TASK)
    rows = raw.get("attachments") if isinstance(raw, dict) else None
    if not isinstance(rows, list):
        raise HTTPException(502, "Das Dashboard liefert die Anhänge in unbekannter Form")
    names = {int(r["id"]): str(r.get("filename") or "anhang") for r in rows if isinstance(r, dict) and isinstance(r.get("id"), int)}
    if attachment_id not in names:
        raise HTTPException(404, NO_ATTACHMENT)
    try:
        data = await host_dash(request, host).download(
            f"{P}/attachments/{attachment_id}", params=_bp(board), missing=NO_ATTACHMENT)
    except UpstreamError as e:
        raise to_http(e) from e
    return Response(data, media_type="application/octet-stream", headers={
        "Content-Disposition": "attachment; filename*=UTF-8''" + quote(names[attachment_id][:200], safe=""),
        "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox"})


@router.delete("/h/{host}/_kanban/attachments/{attachment_id}")
async def attachment_delete(request: Request, host: HostId, attachment_id: int,
                            board: BoardQ = None, user: User = Depends(fresh_user)):
    _limit(request, user, "kanban-attachments")
    raw = await dash(request, host, "DELETE", f"{P}/attachments/{attachment_id}", params=_bp(board), missing=NO_ATTACHMENT)
    if not isinstance(raw, dict) or not raw.get("ok"):
        raise HTTPException(502, "Das Dashboard hat den Anhang nicht gelöscht")
    _rec(request, user, "kanban.attachment.delete", host, attachment=attachment_id)
    return {"ok": True, "deleted": attachment_id}


ARCHIVE_LIMIT = 50 * 1024 * 1024  # wie der Profil-Import: größere Archive lehnt das BFF ab


class BoardExport(Strict):
    attachments: bool = True
    logs: bool = False


@router.post("/h/{host}/_kanban/boards/{slug}/export")
async def board_export(request: Request, host: HostId, slug: Slug, body: BoardExport,
                       board: BoardQ = None, user: User = Depends(fresh_user)):
    _limit(request, user, "kanban-admin")
    # Annahme wie beim Profil-Import: BFF und Dashboard teilen sich das Dateisystem (ein Rechner, ein hostd)
    fd, tmp = tempfile.mkstemp(suffix=".tar.gz")
    os.close(fd)
    try:
        raw = await dash(request, host, "POST", f"{P}/boards/{slug}/export",
                         body={"output": tmp, "attachments": body.attachments, "logs": body.logs},
                         params=_bp(board), missing="Dieses Board gibt es nicht")
        archive = raw.get("archive") if isinstance(raw, dict) else None
        if not isinstance(archive, str) or archive != tmp:
            raise HTTPException(502, "Das Dashboard liefert kein lesbares Archiv zurück")
        try:
            if Path(tmp).stat().st_size > ARCHIVE_LIMIT:
                raise HTTPException(502, "Das Board-Archiv ist zu groß für den Zwischenspeicher")
            data = Path(tmp).read_bytes()
        except OSError as e:
            raise HTTPException(502, "Das Dashboard-Archiv lässt sich nicht lesen") from e
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    _rec(request, user, "kanban.board.export", host, board=slug)
    return Response(data, media_type="application/octet-stream", headers={
        "Content-Disposition": "attachment; filename*=UTF-8''" + quote(f"{slug}.tar.gz", safe=""),
        "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox"})


@router.post("/h/{host}/_kanban/boards/import", status_code=201)
async def board_import(request: Request, host: HostId, archive: UploadFile = File(...),
                       board: BoardQ = None, user: User = Depends(fresh_user)):
    _limit(request, user, "kanban-admin")
    data = await archive.read()
    if len(data) > ARCHIVE_LIMIT:
        raise HTTPException(413, "Das Archiv ist zu groß (max. 50 MB)")
    fname = (archive.filename or "").lower()
    if not fname.endswith((".tar.gz", ".tgz", ".zip")) or not (data[:2] == b"PK" or data[:2] == b"\x1f\x8b"):
        raise HTTPException(422, "Nur .tar.gz oder .zip aus dem Dateidialog")
    fd, tmp = tempfile.mkstemp(suffix=".tar.gz")
    try:
        with os.fdopen(fd, "wb") as tmp_file:
            tmp_file.write(data)
        raw = await dash(request, host, "POST", f"{P}/boards/import", body={"archive": tmp},
                         params=_bp(board), missing=MISSING)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    landed = raw.get("board") if isinstance(raw, dict) else None
    if not isinstance(landed, str) or not landed:
        raise HTTPException(502, "Das Dashboard hat das Board nicht angelegt")
    _rec(request, user, "kanban.board.import", host, board=landed)
    return {"ok": True, "board": landed}


class BoardDelete(Strict):
    confirm: str


@router.delete("/h/{host}/_kanban/boards/{slug}")
async def board_delete(request: Request, host: HostId, slug: Slug, body: BoardDelete,
                       board: BoardQ = None, user: User = Depends(fresh_user)):
    _limit(request, user, "kanban-admin")
    if body.confirm != slug:
        raise HTTPException(422, "Löschen: den Board-Namen zur Bestätigung eingeben")
    # ohne ?delete=true: das Dashboard archiviert nur (kein hartes Löschen aus der WebUI)
    raw = await dash(request, host, "DELETE", f"{P}/boards/{slug}", params=_bp(board), missing="Dieses Board gibt es nicht")
    if not isinstance(raw, dict) or not raw.get("ok"):
        raise HTTPException(502, "Das Dashboard hat das Board nicht archiviert")
    cur = await dash(request, host, "GET", f"{P}/boards", missing=MISSING)
    rows = cur.get("boards") if isinstance(cur, dict) else None
    if not isinstance(rows, list) or any(isinstance(b, dict) and b.get("slug") == slug and not b.get("archived") for b in rows):
        raise HTTPException(502, "Das Dashboard hat das Board nicht archiviert")
    _rec(request, user, "kanban.board.delete", host, board=slug)
    return {"ok": True, "board": slug}
