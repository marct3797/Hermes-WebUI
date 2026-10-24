"""Kanban als bedienbares Board: feste, geprüfte Routen auf das Kanban-Plugin des Dashboards (boardbezogen, Profile sind nur Assignees)."""
from __future__ import annotations

import asyncio
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from .. import kanban
from ..auth import User, current_user, fresh_user
from ..registry import ID_RE
from ._dash import dash

router = APIRouter(prefix="/bff")
P = "/api/plugins/kanban"
HostId = Annotated[str, Path(pattern=ID_RE.pattern)]
SLUG = r"^[a-z0-9][a-z0-9_-]{0,63}$"
TASK = r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
ASSIGNEE = r"^([A-Za-z0-9][A-Za-z0-9_.-]{0,63})?$"  # leer = Zuweisung aufheben
Slug = Annotated[str, Path(pattern=SLUG)]
TaskId = Annotated[str, Path(pattern=TASK)]
BoardQ = Annotated[str | None, Query(pattern=SLUG)]
Status = Annotated[str, Field(pattern=r"^[a-z][a-z_]{0,29}$")]
Title = Annotated[str, Field(min_length=1, max_length=300)]
Text = Annotated[str, Field(max_length=100_000)]
Prio = Annotated[int, Field(ge=-100, le=100)]
Color = Annotated[str, Field(pattern=r"^(#[0-9a-fA-F]{6})?$")]
Who = Annotated[str, Field(pattern=ASSIGNEE)]
Tid = Annotated[str, Field(pattern=TASK)]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class NewTask(Strict):
    title: Title
    body: Text = ""
    assignee: Who = ""
    priority: Prio = 0
    status: Status = "ready"
    parents: list[Tid] = Field(default_factory=list, max_length=20)


class TaskPatch(Strict):
    status: Status | None = None
    assignee: Who | None = None
    priority: Prio | None = None
    title: Title | None = None
    body: Text | None = None
    block_reason: Annotated[str, Field(max_length=2000)] | None = None
    result: Annotated[str, Field(max_length=20_000)] | None = None
    summary: Annotated[str, Field(max_length=20_000)] | None = None


class Comment(Strict):
    body: Annotated[str, Field(min_length=1, max_length=10_000)]


class Reassign(Strict):
    assignee: Who
    reclaim_first: bool = False


class Link(Strict):
    parent_id: Tid
    child_id: Tid


class Bulk(Strict):
    ids: list[Tid] = Field(min_length=1, max_length=50)
    status: Status | None = None
    assignee: Who | None = None
    priority: Prio | None = None
    archive: bool = False


class NewBoard(Strict):
    slug: Annotated[str, Field(pattern=SLUG)]
    name: Annotated[str, Field(min_length=1, max_length=80)]
    description: Annotated[str, Field(max_length=300)] = ""
    icon: Annotated[str, Field(max_length=16)] = ""
    color: Color = ""


class BoardPatch(Strict):
    name: Annotated[str, Field(min_length=1, max_length=80)] | None = None
    description: Annotated[str, Field(max_length=300)] | None = None
    icon: Annotated[str, Field(max_length=16)] | None = None
    color: Color | None = None


MISSING = "Kanban oder dieses Board ist auf dem Dashboard nicht verfügbar"
NO_TASK = "Diese Aufgabe gibt es nicht"


def _body(model: BaseModel) -> dict[str, Any]:
    return model.model_dump(exclude_none=True)


def _rec(request: Request, user: User, action: str, host: str, **detail: Any) -> None:
    request.app.state.audit.record(action, user=user.id, target=host, **detail)


def _bp(board: str | None) -> dict[str, str] | None:
    return {"board": board} if board else None


def _no_direct(status: str | None) -> None:
    if status == "archived":
        raise HTTPException(422, "Archivieren geht nur über die Aktion Archivieren")
    if status == "running":
        raise HTTPException(422, "Laufend setzt nur der Dispatcher, nicht die Oberfläche")


async def _check_status(request: Request, host: str, board: str | None, status: str | None) -> None:
    """Zielspalte muss eine Spalte dieses Boards sein (das Board kennt die Reihenfolge)."""
    if status is None:
        return
    raw = await dash(request, host, "GET", f"{P}/board", params=_bp(board), missing=MISSING)
    if status not in [c["name"] for c in kanban.board(raw, None, None)["columns"]]:
        raise HTTPException(422, "Unbekannte Spalte für dieses Board")


@router.get("/h/{host}/_kanban/boards")
async def list_boards(request: Request, host: HostId, user: User = Depends(current_user)):
    return kanban.boards(await dash(request, host, "GET", f"{P}/boards", missing=MISSING))


@router.post("/h/{host}/_kanban/boards")
async def create_board(request: Request, host: HostId, body: NewBoard, user: User = Depends(fresh_user)):
    raw = await dash(request, host, "POST", f"{P}/boards", body=_body(body), missing=MISSING)
    _rec(request, user, "kanban.board.create", host, board=body.slug)
    return {"board": kanban.board_meta(raw.get("board") or {} if isinstance(raw, dict) else {})}


@router.patch("/h/{host}/_kanban/boards/{slug}")
async def update_board(request: Request, host: HostId, slug: Slug, body: BoardPatch, user: User = Depends(fresh_user)):
    changes = _body(body)
    if not changes:
        raise HTTPException(422, "Keine Änderung angegeben")
    raw = await dash(request, host, "PATCH", f"{P}/boards/{slug}", body=changes, missing="Dieses Board gibt es nicht")
    _rec(request, user, "kanban.board.update", host, board=slug, fields=",".join(changes))
    return {"board": kanban.board_meta(raw.get("board") or {} if isinstance(raw, dict) else {})}


@router.get("/h/{host}/_kanban/board")
async def get_board(request: Request, host: HostId, board: BoardQ = None, include_archived: bool = False, user: User = Depends(current_user)):
    params = {**(_bp(board) or {}), **({"include_archived": "true"} if include_archived else {})}
    raw, assignees, stats = await asyncio.gather(
        dash(request, host, "GET", f"{P}/board", params=params, missing=MISSING),
        dash(request, host, "GET", f"{P}/assignees", params=_bp(board), missing=MISSING),
        dash(request, host, "GET", f"{P}/stats", params=_bp(board), missing=MISSING))
    return kanban.board(raw, assignees, stats)


@router.get("/h/{host}/_kanban/tasks/{task_id}")
async def get_task(request: Request, host: HostId, task_id: TaskId, board: BoardQ = None, user: User = Depends(current_user)):
    return kanban.detail(await dash(request, host, "GET", f"{P}/tasks/{task_id}", params=_bp(board), missing=NO_TASK))


@router.get("/h/{host}/_kanban/tasks/{task_id}/log")
async def get_log(request: Request, host: HostId, task_id: TaskId, board: BoardQ = None,
                  tail: Annotated[int, Query(ge=1, le=200_000)] = kanban.LOG_DEFAULT_TAIL, user: User = Depends(current_user)):
    return kanban.log(await dash(request, host, "GET", f"{P}/tasks/{task_id}/log", params={"tail": str(tail), **(_bp(board) or {})}, missing=NO_TASK))


@router.post("/h/{host}/_kanban/tasks")
async def create_task(request: Request, host: HostId, body: NewTask, board: BoardQ = None, user: User = Depends(fresh_user)):
    if body.status not in ("todo", "ready", "triage"):
        raise HTTPException(422, "Neue Aufgaben starten in triage, todo oder ready")
    payload = {"title": body.title, "body": body.body or None, "assignee": body.assignee or None, "priority": body.priority,
               "parents": body.parents, "triage": body.status == "triage"}
    raw = await dash(request, host, "POST", f"{P}/tasks", body=payload, params=_bp(board), missing=MISSING)
    raw = raw if isinstance(raw, dict) else {}
    task = raw.get("task") if isinstance(raw.get("task"), dict) else {}
    tid = task.get("id") if isinstance(task.get("id"), str) else None
    if tid and body.status == "todo" and task.get("status") != "todo":
        await dash(request, host, "PATCH", f"{P}/tasks/{tid}", body={"status": "todo"}, params=_bp(board), missing=NO_TASK)
    _rec(request, user, "kanban.task.create", host, task=tid, board=board, title_len=len(body.title))
    return {"id": tid, "warning": kanban._s(raw.get("warning"), 300)}


@router.patch("/h/{host}/_kanban/tasks/{task_id}")
async def update_task(request: Request, host: HostId, task_id: TaskId, body: TaskPatch, board: BoardQ = None, user: User = Depends(fresh_user)):
    changes = _body(body)
    if not changes:
        raise HTTPException(422, "Keine Änderung angegeben")
    _no_direct(body.status)
    await _check_status(request, host, board, body.status)
    await dash(request, host, "PATCH", f"{P}/tasks/{task_id}", body=changes, params=_bp(board), missing=NO_TASK)
    _rec(request, user, "kanban.task.move" if list(changes) == ["status"] else "kanban.task.update", host, task=task_id, fields=",".join(changes))
    return {"ok": True}


@router.post("/h/{host}/_kanban/tasks/{task_id}/comments")
async def add_comment(request: Request, host: HostId, task_id: TaskId, body: Comment, board: BoardQ = None, user: User = Depends(fresh_user)):
    await dash(request, host, "POST", f"{P}/tasks/{task_id}/comments", body={"body": body.body}, params=_bp(board), missing=NO_TASK)
    _rec(request, user, "kanban.task.comment", host, task=task_id, length=len(body.body))
    return {"ok": True}


@router.post("/h/{host}/_kanban/tasks/{task_id}/reassign")
async def reassign(request: Request, host: HostId, task_id: TaskId, body: Reassign, board: BoardQ = None, user: User = Depends(fresh_user)):
    await dash(request, host, "POST", f"{P}/tasks/{task_id}/reassign", body={"profile": body.assignee, "reclaim_first": body.reclaim_first},
               params=_bp(board), missing=NO_TASK)
    _rec(request, user, "kanban.task.reassign", host, task=task_id, assignee=body.assignee)
    return {"ok": True}


@router.post("/h/{host}/_kanban/tasks/{task_id}/reclaim")
async def reclaim(request: Request, host: HostId, task_id: TaskId, board: BoardQ = None, user: User = Depends(fresh_user)):
    await dash(request, host, "POST", f"{P}/tasks/{task_id}/reclaim", body={}, params=_bp(board), missing=NO_TASK)
    _rec(request, user, "kanban.task.reassign", host, task=task_id, reclaim=True)
    return {"ok": True}


@router.post("/h/{host}/_kanban/links")
async def add_link(request: Request, host: HostId, body: Link, board: BoardQ = None, user: User = Depends(fresh_user)):
    raw = await dash(request, host, "POST", f"{P}/links", body=body.model_dump(), params=_bp(board), missing=NO_TASK)
    _rec(request, user, "kanban.task.update", host, task=body.child_id, link=body.parent_id)
    return {"ok": True, "gated": bool(raw.get("gated")) if isinstance(raw, dict) else False}


@router.delete("/h/{host}/_kanban/links")
async def remove_link(request: Request, host: HostId, parent_id: Annotated[str, Query(pattern=TASK)], child_id: Annotated[str, Query(pattern=TASK)],
                      board: BoardQ = None, user: User = Depends(fresh_user)):
    await dash(request, host, "DELETE", f"{P}/links", params={"parent_id": parent_id, "child_id": child_id, **(_bp(board) or {})}, missing=NO_TASK)
    _rec(request, user, "kanban.task.update", host, task=child_id, unlink=parent_id)
    return {"ok": True}


@router.post("/h/{host}/_kanban/tasks/bulk")
async def bulk(request: Request, host: HostId, body: Bulk, board: BoardQ = None, user: User = Depends(fresh_user)):
    edits = body.status is not None or body.assignee is not None or body.priority is not None
    _no_direct(body.status)
    if body.archive == edits:  # genau eines von beidem: Archivieren oder Änderungen
        raise HTTPException(422, "Archivieren lässt sich nicht mit anderen Änderungen mischen, und es braucht eine Änderung")
    await _check_status(request, host, board, body.status)
    raw = await dash(request, host, "POST", f"{P}/tasks/bulk", body=_body(body), params=_bp(board), missing=MISSING)
    results = [{"id": kanban._s(r.get("id"), 64), "ok": bool(r.get("ok")), "error": kanban._s(r.get("error"), 300)}
               for r in kanban._rows(raw.get("results") if isinstance(raw, dict) else None)]
    action = "kanban.task.archive" if body.archive else "kanban.task.move" if body.status is not None else "kanban.task.update"
    _rec(request, user, action, host, tasks=",".join(body.ids), failed=sum(not r["ok"] for r in results))
    return {"results": results}
