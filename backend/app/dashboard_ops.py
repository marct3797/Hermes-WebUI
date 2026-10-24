"""Lesende Ersatzquelle für Host-Daten: das Dashboard einer Maschine.

Der Host-Dienst liest Profile aus dem Dateisystem. Läuft Hermes in einem Container, sieht er sie nicht. Das Dashboard
läuft im Container und liefert Kanban, Logs, MCP, Plugins, Skills und Suche über seine API. Hier wird es auf die Formen
des Host-Dienstes abgebildet. Es wird nie geschrieben, Env, Argumente und URLs der MCP-Server bleiben draußen,
und jeder Text wird wie im Host-Dienst geschwärzt.
"""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from .adapters import UpstreamError
from .dashboard import DashboardClient

NOTE = "Quelle: Hermes-Dashboard dieses Hosts, nur lesend. Änderungen sind hier nicht möglich."
LOG_LINES = 500
LOG_CHARS = 64 * 1024
TASKS_PER_COLUMN = 50
TEXT_CHARS = 600
SEARCH_LIMIT = 20  # so viele Treffer liefert das Dashboard höchstens

_URL = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://[^\s<>\"']+")
_KEY_BLOCK = re.compile(r"-----BEGIN [^-]*PRIVATE KEY-----.*?(?:-----END [^-]*PRIVATE KEY-----|\Z)", re.S)
_SECRET_LINE = re.compile(
    r"(?i)(authorization|cookie|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|secret|token|bearer\s+|sk-[A-Za-z0-9]|eyJ[A-Za-z0-9_-]{12}|^[A-Za-z0-9+/=]{48,}$)")


def redact(text: Any) -> str:
    """Wie der Host-Dienst: URLs ohne Zugangsteil und Query, Schlüsselblöcke und Zeilen mit Geheimnissen entfallen."""
    def clean_url(match: re.Match) -> str:
        try:
            u = urlsplit(match.group())
            host = f"[{u.hostname}]" if u.hostname and ":" in u.hostname else (u.hostname or "")
            return urlunsplit((u.scheme, host + (f":{u.port}" if u.port else ""), u.path, "", ""))
        except ValueError:
            return "[redacted-url]"
    text = _KEY_BLOCK.sub("[redacted-key]", _URL.sub(clean_url, str(text)))
    return "\n".join("[redacted]" if _SECRET_LINE.search(line) else line for line in text.splitlines())


def clip(value: Any, limit: int = TEXT_CHARS) -> str:
    return redact(value)[:limit] if isinstance(value, str) else ""


def _list(body: Any, key: str | None = None) -> list[dict[str, Any]]:
    rows = body.get(key) if key and isinstance(body, dict) else body
    if not isinstance(rows, list):
        raise UpstreamError(502, "Das Dashboard liefert diese Daten in unbekannter Form")
    return [r for r in rows if isinstance(r, dict)]


async def profiles(dash: DashboardClient) -> list[dict[str, str]]:
    return [{"id": p["name"]} for p in await dash.profiles() if isinstance(p.get("name"), str)]


def _name(row: dict[str, Any]) -> str:
    return row["name"] if isinstance(row.get("name"), str) else ""


async def listing(dash: DashboardClient, profile: str, kind: str) -> dict[str, Any]:
    base = {"available": True, "reason": None, "note": NOTE, "source": "dashboard", "actions": []}
    if kind == "skills":
        rows = _list(await dash.skills(profile))
        return {**base, "items": [{"id": _name(r), "name": _name(r), "description": clip(r.get("description"), 300),
                                   "enabled": r["enabled"] if isinstance(r.get("enabled"), bool) else None,
                                   "status": " · ".join(clip(r.get(k), 40) for k in ("category", "provenance") if r.get(k))}
                                  for r in rows if _name(r)]}
    if kind == "mcp":  # Env, Argumente und URLs können Zugangsdaten tragen: nur Name, Übertragung und Schalter
        rows = _list(await dash.mcp_servers(profile), "servers")
        return {**base, "items": [{"id": _name(r), "name": _name(r), "description": f"Übertragung: {clip(r.get('transport'), 20) or 'unbekannt'}",
                                   "enabled": r["enabled"] if isinstance(r.get("enabled"), bool) else None}
                                  for r in rows if _name(r)]}
    if kind == "plugins":
        rows = _list(await dash.plugin_hub(profile), "plugins")
        return {**base, "items": [{"id": _name(r), "name": _name(r), "description": clip(r.get("description"), 300),
                                   "status": clip(r.get("runtime_status"), 40) or "Status unbekannt",
                                   "version": clip(r.get("version"), 40)} for r in rows if _name(r)]}
    if kind == "logs":
        body = await dash.logs(profile, LOG_LINES)
        lines = body.get("lines") if isinstance(body, dict) else None
        if not isinstance(lines, list):
            raise UpstreamError(502, "Das Dashboard liefert Logs in unbekannter Form")
        text = redact("\n".join(str(x).rstrip("\n") for x in lines))
        return {**base, "content": text[-LOG_CHARS:], "redacted": True, "truncated": len(text) > LOG_CHARS or len(lines) >= LOG_LINES}
    if kind == "kanban":
        board = await dash.kanban_board(profile)
        columns = _list(board, "columns")
        tasks, cut = [], False
        for column in columns:
            status = _name(column)
            rows = [t for t in column.get("tasks", []) if isinstance(t, dict) and isinstance(t.get("id"), str) and isinstance(t.get("title"), str)]
            rows.sort(key=lambda t: t.get("completed_at") or t.get("created_at") or 0, reverse=True)
            cut |= len(rows) > TASKS_PER_COLUMN
            tasks += [{"id": t["id"], "title": clip(t["title"], 200), "status": status, "description": clip(t.get("body")),
                       "assignee": clip(t.get("assignee"), 64)} for t in rows[:TASKS_PER_COLUMN]]
        return {**base, "columns": [_name(c) for c in columns if _name(c)], "tasks": tasks, "truncated": cut,
                "note": NOTE + " Pro Spalte die neuesten " + str(TASKS_PER_COLUMN) + " Aufgaben."}
    raise UpstreamError(404, "Unbekannte Datenart")


async def search(dash: DashboardClient, query: str) -> dict[str, Any]:
    rows = _list(await dash.session_search(query), "results")
    out = [{"profile": clip(r.get("profile"), 64), "session_id": clip(r.get("session_id") or r.get("id"), 128),
            "title": clip(r.get("title"), 300), "snippet": clip(r.get("snippet"), 1000)} for r in rows]
    return {"results": [r for r in out if r["profile"] and r["session_id"]], "truncated": len(rows) >= SEARCH_LIMIT}
