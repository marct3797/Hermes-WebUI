"""Kanban: Antworten des Dashboard-Plugins in schlanke, geprüfte Formen umsetzen (keine Rohdurchreichung, keine Pfade)."""
from __future__ import annotations

from typing import Any

from .dashboard_ops import redact

CARD_SNIPPET = 300
LOG_DEFAULT_TAIL = 20_000


def _s(v: Any, limit: int = 500) -> str | None:
    return v[:limit] if isinstance(v, str) else None


def _i(v: Any) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def _rows(v: Any) -> list[dict]:
    return [r for r in v if isinstance(r, dict)] if isinstance(v, list) else []


def _counts(v: Any) -> dict[str, int]:
    return {k: n for k, n in v.items() if isinstance(k, str) and isinstance(_i(n), int)} if isinstance(v, dict) else {}


def _warn(v: Any) -> dict[str, Any]:
    v = v if isinstance(v, dict) else {}
    return {"count": _i(v.get("count")) or 0, "highest_severity": _s(v.get("highest_severity"), 20)}


def card(t: dict) -> dict:
    age = t.get("age") if isinstance(t.get("age"), dict) else {}
    links = t.get("link_counts") if isinstance(t.get("link_counts"), dict) else {}
    return {
        "id": _s(t.get("id"), 64), "title": _s(t.get("title"), 300) or "", "status": _s(t.get("status"), 30),
        "assignee": _s(t.get("assignee"), 64), "priority": _i(t.get("priority")) or 0,
        "created_at": _i(t.get("created_at")), "completed_at": _i(t.get("completed_at")),
        "age_seconds": _i(age.get("created_age_seconds")), "comment_count": _i(t.get("comment_count")) or 0,
        "link_counts": {"parents": _i(links.get("parents")) or 0, "children": _i(links.get("children")) or 0},
        "warnings": _warn(t.get("warnings")), "block_kind": _s(t.get("block_kind"), 40),
        "snippet": redact(t["body"])[:CARD_SNIPPET] if isinstance(t.get("body"), str) else "",
    }


def board(raw: Any, assignees: Any, stats: Any) -> dict:
    cols = _rows(raw.get("columns") if isinstance(raw, dict) else None)
    st = stats if isinstance(stats, dict) else {}
    return {
        "columns": [{"name": _s(c.get("name"), 30), "tasks": [card(t) for t in _rows(c.get("tasks"))]} for c in cols],
        "assignees": [{"name": _s(a.get("name"), 64), "counts": _counts(a.get("counts"))}
                      for a in _rows(assignees.get("assignees") if isinstance(assignees, dict) else None)],
        "stats": {"by_status": _counts(st.get("by_status")), "oldest_ready_age_seconds": _i(st.get("oldest_ready_age_seconds"))},
    }


def board_meta(b: dict) -> dict:
    return {"slug": _s(b.get("slug"), 64), "name": _s(b.get("name"), 100) or _s(b.get("slug"), 64), "description": _s(b.get("description"), 500) or "",
            "icon": _s(b.get("icon"), 16) or "", "color": _s(b.get("color"), 16) or "", "archived": bool(b.get("archived")),
            "is_current": bool(b.get("is_current")), "counts": _counts(b.get("counts")), "total": _i(b.get("total")) or 0}


def boards(raw: Any) -> dict:
    return {"boards": [board_meta(b) for b in _rows(raw.get("boards") if isinstance(raw, dict) else None)],
            "current": _s(raw.get("current"), 64) if isinstance(raw, dict) else None}


def detail(raw: Any) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    t = raw.get("task") if isinstance(raw.get("task"), dict) else {}
    c = card(t)
    links = raw.get("links") if isinstance(raw.get("links"), dict) else {}
    ids = lambda v: [x[:64] for x in v if isinstance(x, str)] if isinstance(v, list) else []  # noqa: E731
    # Text der Person (Titel, Beschreibung, Kommentare) bleibt vollständig: sonst würde Speichern ihn kürzen. Maschinentexte werden geschwärzt.
    return {
        "task": {**{k: c[k] for k in ("id", "title", "status", "assignee", "priority", "created_at", "completed_at", "block_kind")},
                 "body": t.get("body") if isinstance(t.get("body"), str) else "", "created_by": _s(t.get("created_by"), 64),
                 "started_at": _i(t.get("started_at")), "result": redact(t["result"]) if isinstance(t.get("result"), str) else None,
                 "summary": redact(t["latest_summary"]) if isinstance(t.get("latest_summary"), str) else None,
                 "consecutive_failures": _i(t.get("consecutive_failures")) or 0, "last_failure_error": _s(redact(t.get("last_failure_error") or ""), 500) or None},
        "comments": [{"id": _i(x.get("id")), "author": _s(x.get("author"), 64), "body": x.get("body") if isinstance(x.get("body"), str) else "",
                      "created_at": _i(x.get("created_at"))} for x in _rows(raw.get("comments"))],
        "events": [{"id": _i(x.get("id")), "kind": _s(x.get("kind"), 40), "created_at": _i(x.get("created_at")), "run_id": _i(x.get("run_id"))}
                   for x in _rows(raw.get("events"))],
        "runs": [{"id": _i(x.get("id")), "profile": _s(x.get("profile"), 64), "status": _s(x.get("status"), 30), "outcome": _s(x.get("outcome"), 30),
                  "started_at": _i(x.get("started_at")), "ended_at": _i(x.get("ended_at")),
                  "summary": redact(x["summary"])[:2000] if isinstance(x.get("summary"), str) else None,
                  "error": redact(x["error"])[:500] if isinstance(x.get("error"), str) else None} for x in _rows(raw.get("runs"))],
        "links": {"parents": ids(links.get("parents")), "children": ids(links.get("children"))},
        "link_tasks": [{"id": _s(x.get("id"), 64), "title": _s(x.get("title"), 300) or "", "status": _s(x.get("status"), 30)} for x in _rows(raw.get("link_tasks"))],
        "diagnostics": [{"kind": _s(x.get("kind"), 60), "severity": _s(x.get("severity"), 20), "title": redact(x.get("title") or "")[:200],
                         "detail": redact(x.get("detail") or "")[:500]} for x in _rows(t.get("diagnostics"))],
    }


def log(raw: Any) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    return {"exists": bool(raw.get("exists")), "size_bytes": _i(raw.get("size_bytes")) or 0, "truncated": bool(raw.get("truncated")),
            "content": redact(raw.get("content") or "")}
