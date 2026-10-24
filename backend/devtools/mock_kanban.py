"""Kanban-Plugin des Dashboards als Test-Ersatz (Formen nach plugins/kanban/dashboard/plugin_api.py und echten, bereinigten Antworten).

Zustand im Speicher: Boards `default` und `alpha`, Aufgaben mit Kommentaren, Links, Runs und Log. `fail=<Statuscode>` lässt jede Route so scheitern.
Start: uvicorn devtools.mock_kanban:app --port 9123
"""
from __future__ import annotations

import itertools
import time
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Query, Request
from pydantic import BaseModel

COLUMNS = ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done"]
NOW = 1_792_000_000
LOG = "Start der Aufgabe\r\nAuthorization: Bearer abc123\r\nsiehe https://user:pw@example.com/pfad?token=1\r\nFertig\r\n"


def task(tid: str, title: str, status: str, assignee: Optional[str] = None, **kw: Any) -> dict:
    return {"id": tid, "title": title, "body": kw.pop("body", f"Beschreibung von {title}"), "assignee": assignee, "status": status, "priority": 0,
            "created_by": "user", "created_at": NOW - 3600, "started_at": None, "completed_at": NOW - 60 if status == "done" else None,
            "workspace_kind": "scratch", "workspace_path": "/opt/data/kanban/ws/" + tid, "result": None, "block_kind": None,
            "consecutive_failures": 0, "last_failure_error": None, "latest_summary": kw.pop("summary", None), "tenant": None,
            "age": {"created_age_seconds": 3600, "started_age_seconds": None, "time_to_complete_seconds": None}, "parents": [], **kw}


def seed() -> dict[str, Any]:
    t = [task("t_aaaa0001", "Recherche Marken", "done", "alpha", summary="Fertig, siehe Notiz"),
         task("t_aaaa0002", "Freigabe prüfen", "blocked", "gamma", block_kind="needs_input"),
         task("t_aaaa0003", "Bericht schreiben", "ready", "beta", body="Ein **Bericht**.\npassword: geheim123"),
         task("t_aaaa0004", "Nachbereitung", "todo", None, parents=["t_aaaa0003"]),
         task("t_aaaa0005", "Alte Aufgabe", "done", "alpha", archived=True)]
    return {"current": "default", "boards": {
        "default": {"meta": {"slug": "default", "name": "Default", "description": "", "icon": "", "color": "", "archived": False,
                             "db_path": "/opt/data/kanban.db", "default_workdir": "/srv/x"},
                    "tasks": {x["id"]: x for x in t}, "comments": {"t_aaaa0002": [{"id": 1, "task_id": "t_aaaa0002", "author": "gamma", "body": "Wartet auf Antwort", "created_at": NOW - 100}]},
                    "runs": {"t_aaaa0002": [{"id": 7, "task_id": "t_aaaa0002", "profile": "gamma", "status": "blocked", "outcome": "blocked", "started_at": NOW - 900,
                                             "ended_at": NOW - 800, "summary": "Blockiert\ntoken=abc", "error": None, "claim_lock": "x:1", "metadata": None}]}},
        "alpha": {"meta": {"slug": "alpha", "name": "Alpha", "description": "Zweites Board", "icon": "", "color": "#336699", "archived": False,
                           "db_path": "/opt/data/kanban/boards/alpha/kanban.db", "default_workdir": None}, "tasks": {}, "comments": {}, "runs": {}}}}


class Create(BaseModel):
    title: str
    body: Optional[str] = None
    assignee: Optional[str] = None
    priority: int = 0
    parents: list[str] = []
    triage: bool = False


class Update(BaseModel):
    status: Optional[str] = None
    assignee: Optional[str] = None
    priority: Optional[int] = None
    title: Optional[str] = None
    body: Optional[str] = None
    block_reason: Optional[str] = None
    result: Optional[str] = None
    summary: Optional[str] = None


class Bulk(BaseModel):
    ids: list[str]
    status: Optional[str] = None
    assignee: Optional[str] = None
    priority: Optional[int] = None
    archive: bool = False


class CommentIn(BaseModel):
    body: str
    author: Optional[str] = "dashboard"


class LinkIn(BaseModel):
    parent_id: str
    child_id: str


class Reassign(BaseModel):
    profile: Optional[str] = None
    reclaim_first: bool = False


class BoardIn(BaseModel):
    slug: Optional[str] = None
    name: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None


def create_mock() -> FastAPI:
    app = FastAPI()
    app.state.db = seed()
    app.state.fail = None
    app.state.calls = []  # (Methode, Pfad, Query, Body) jeder Anfrage, damit Tests prüfen, was wirklich ankam
    ids = itertools.count(100)

    @app.middleware("http")
    async def failing(request: Request, call_next):
        body = (await request.body()).decode() or None
        app.state.calls.append((request.method, request.url.path, dict(request.query_params), body))
        if app.state.fail:
            from fastapi.responses import JSONResponse
            return JSONResponse({"detail": "Kanban-Fehler im Test"}, status_code=app.state.fail)
        return await call_next(request)

    def bd(board: Optional[str]) -> dict:
        slug = board or app.state.db["current"]
        if slug not in app.state.db["boards"]:
            raise HTTPException(404, f"board {slug!r} does not exist")
        return app.state.db["boards"][slug]

    def tk(b: dict, tid: str) -> dict:
        if tid not in b["tasks"]:
            raise HTTPException(404, f"task {tid} not found")
        return b["tasks"][tid]

    def view(b: dict, t: dict) -> dict:
        out = {k: v for k, v in t.items() if k not in ("parents", "archived")}
        out["warnings"] = {"count": 1, "kinds": {"stuck_in_blocked": 1}, "latest_at": NOW, "highest_severity": "warning"} if t["status"] == "blocked" else {"count": 0, "kinds": {}, "latest_at": None, "highest_severity": None}
        out["diagnostics"] = [{"kind": "stuck_in_blocked", "severity": "warning", "title": "Aufgabe blockiert", "detail": "Wartet seit Stunden", "actions": []}] if t["status"] == "blocked" else []
        return out

    def links(b: dict, tid: str) -> dict:
        return {"parents": list(b["tasks"][tid]["parents"]), "children": [k for k, v in b["tasks"].items() if tid in v["parents"]]}

    @app.get("/api/plugins/kanban/boards")
    def boards():
        out = []
        for slug, b in app.state.db["boards"].items():
            counts: dict[str, int] = {}
            for t in b["tasks"].values():
                key = "archived" if t.get("archived") else t["status"]
                counts[key] = counts.get(key, 0) + 1
            out.append({**b["meta"], "is_current": slug == app.state.db["current"], "counts": counts, "total": sum(n for k, n in counts.items() if k != "archived")})
        return {"boards": out, "current": app.state.db["current"]}

    @app.post("/api/plugins/kanban/boards")
    def create_board(p: BoardIn):
        if not p.slug or p.slug in app.state.db["boards"]:
            raise HTTPException(400, "board slug missing or exists")
        meta = {"slug": p.slug, "name": p.name or p.slug, "description": p.description or "", "icon": p.icon or "", "color": p.color or "", "archived": False,
                "db_path": "/x", "default_workdir": None}
        app.state.db["boards"][p.slug] = {"meta": meta, "tasks": {}, "comments": {}, "runs": {}}
        return {"board": meta, "current": app.state.db["current"]}

    @app.patch("/api/plugins/kanban/boards/{slug}")
    def patch_board(slug: str, p: BoardIn):
        b = bd(slug)
        b["meta"].update({k: v for k, v in p.model_dump(exclude={"slug"}).items() if v is not None})
        return {"board": b["meta"]}

    @app.get("/api/plugins/kanban/board")
    def board(board: Optional[str] = None, include_archived: bool = False):
        b = bd(board)
        cols = {c: [] for c in COLUMNS}
        if include_archived:
            cols["archived"] = []
        for t in b["tasks"].values():
            if t.get("archived") and not include_archived:
                continue
            v = view(b, t)
            v["comment_count"] = len(b["comments"].get(t["id"], []))
            v["link_counts"] = {"parents": len(links(b, t["id"])["parents"]), "children": len(links(b, t["id"])["children"])}
            cols["archived" if t.get("archived") else t["status"]].append(v)
        return {"columns": [{"name": c, "tasks": ts} for c, ts in cols.items()], "tenants": [], "assignees": [], "latest_event_id": 1, "now": NOW}

    @app.get("/api/plugins/kanban/assignees")
    def assignees(board: Optional[str] = None):
        b = bd(board)
        names: dict[str, dict] = {n: {} for n in ("alpha", "beta", "gamma", "default")}
        for t in b["tasks"].values():
            if t["assignee"] and not t.get("archived"):
                names.setdefault(t["assignee"], {})
                names[t["assignee"]][t["status"]] = names[t["assignee"]].get(t["status"], 0) + 1
        return {"assignees": [{"name": n, "on_disk": True, "counts": c} for n, c in names.items()]}

    @app.get("/api/plugins/kanban/stats")
    def stats(board: Optional[str] = None):
        by: dict[str, int] = {}
        for t in bd(board)["tasks"].values():
            if not t.get("archived"):
                by[t["status"]] = by.get(t["status"], 0) + 1
        return {"by_status": by, "by_assignee": {}, "oldest_ready_age_seconds": 120 if by.get("ready") else None, "now": NOW}

    @app.get("/api/plugins/kanban/tasks/{tid}")
    def get_task(tid: str, board: Optional[str] = None):
        b = bd(board)
        t = view(b, tk(b, tid))
        ln = links(b, tid)
        return {"task": t, "comments": b["comments"].get(tid, []), "events": [{"id": 1, "task_id": tid, "kind": "created", "payload": {"workspace_path": "/x"}, "created_at": NOW - 3600, "run_id": None}],
                "attachments": [], "links": ln, "link_tasks": [{"id": i, "title": b["tasks"][i]["title"], "status": b["tasks"][i]["status"]} for i in ln["parents"] + ln["children"]],
                "child_results": [], "runs": b["runs"].get(tid, [])}

    @app.get("/api/plugins/kanban/tasks/{tid}/log")
    def get_log(tid: str, tail: Optional[int] = Query(None, ge=1), board: Optional[str] = None):
        tk(bd(board), tid)
        return {"task_id": tid, "path": "/opt/data/kanban/logs/" + tid + ".log", "exists": True, "size_bytes": len(LOG), "content": LOG, "truncated": bool(tail and tail < len(LOG))}

    @app.post("/api/plugins/kanban/tasks")
    def create_task(p: Create, board: Optional[str] = None):
        b = bd(board)
        for pid in p.parents:
            tk(b, pid)
        tid = f"t_{next(ids):08x}"
        status = "triage" if p.triage else "todo" if p.parents else "ready"
        b["tasks"][tid] = task(tid, p.title, status, p.assignee or None, body=p.body or "", priority=p.priority, parents=list(p.parents))
        return {"task": view(b, b["tasks"][tid])}

    def set_status(b: dict, t: dict, s: str, p: Any) -> None:
        if s == "running":
            raise HTTPException(400, "Cannot set status to 'running' directly; use the dispatcher/claim path")
        if s not in COLUMNS:
            raise HTTPException(400, f"unknown status: {s}")
        open_parents = [pid for pid in t["parents"] if b["tasks"][pid]["status"] != "done"]
        if s in ("ready", "done", "review") and open_parents:
            raise HTTPException(409, f"Cannot move to {s!r}: blocked by parent(s) not done — {', '.join(open_parents)}")
        t["status"] = s
        t["completed_at"] = NOW if s == "done" else None
        if s == "blocked" and getattr(p, "block_reason", None):
            t["block_kind"] = "needs_input"

    @app.patch("/api/plugins/kanban/tasks/{tid}")
    def patch_task(tid: str, p: Update, board: Optional[str] = None):
        b = bd(board)
        t = tk(b, tid)
        if p.assignee is not None:
            t["assignee"] = p.assignee or None
        if p.status is not None:
            set_status(b, t, p.status, p)
        for k in ("priority", "title", "body", "result"):
            if getattr(p, k) is not None:
                t[k] = getattr(p, k)
        if p.summary is not None:
            t["latest_summary"] = p.summary
        return {"task": view(b, t)}

    @app.post("/api/plugins/kanban/tasks/bulk")
    def bulk(p: Bulk, board: Optional[str] = None):
        b = bd(board)
        res = []
        for tid in p.ids:
            e: dict[str, Any] = {"id": tid, "ok": True}
            if tid not in b["tasks"]:
                e.update(ok=False, error="not found")
            else:
                t = b["tasks"][tid]
                try:
                    if p.archive:
                        t["archived"] = True
                    if p.status is not None:
                        set_status(b, t, p.status, p)
                    if p.assignee is not None:
                        t["assignee"] = p.assignee or None
                    if p.priority is not None:
                        t["priority"] = p.priority
                except HTTPException as x:
                    e.update(ok=False, error=str(x.detail))
            res.append(e)
        return {"results": res}

    @app.post("/api/plugins/kanban/tasks/{tid}/comments")
    def comment(tid: str, p: CommentIn, board: Optional[str] = None):
        b = bd(board)
        tk(b, tid)
        if not p.body.strip():
            raise HTTPException(400, "body is required")
        b["comments"].setdefault(tid, []).append({"id": next(ids), "task_id": tid, "author": p.author or "dashboard", "body": p.body, "created_at": NOW})
        return {"ok": True}

    @app.post("/api/plugins/kanban/tasks/{tid}/reassign")
    def reassign(tid: str, p: Reassign, board: Optional[str] = None):
        t = tk(bd(board), tid)
        if t["status"] == "running" and not p.reclaim_first:
            raise HTTPException(409, f"cannot reassign {tid}: unknown id, or still running (pass reclaim_first=true to release the claim first)")
        t["assignee"] = p.profile or None
        return {"ok": True, "task_id": tid, "assignee": t["assignee"]}

    @app.post("/api/plugins/kanban/tasks/{tid}/reclaim")
    def reclaim(tid: str, board: Optional[str] = None):
        t = tk(bd(board), tid)
        if t["status"] != "running":
            raise HTTPException(409, f"cannot reclaim {tid}: not in a claimable state (not running, or unknown id)")
        t["status"] = "ready"
        return {"ok": True, "task_id": tid}

    @app.post("/api/plugins/kanban/links")
    def add_link(p: LinkIn, board: Optional[str] = None):
        b = bd(board)
        tk(b, p.parent_id)
        child = tk(b, p.child_id)
        if p.parent_id == p.child_id:
            raise HTTPException(400, "a task cannot depend on itself")
        if p.parent_id not in child["parents"]:
            child["parents"].append(p.parent_id)
        return {"ok": True, "gated": False}

    @app.delete("/api/plugins/kanban/links")
    def del_link(parent_id: str, child_id: str, board: Optional[str] = None):
        child = tk(bd(board), child_id)
        ok = parent_id in child["parents"]
        if ok:
            child["parents"].remove(parent_id)
        return {"ok": ok}

    return app


app = create_mock()
