"""Adapter zum Hermes API-Server (Port 8642).

Alles, was Hermes-Pfade, Feldnamen oder Event-Formate kennt, steht in dieser Datei. Ändert Hermes
eine Route, wird nur hier angepasst. Die Feldnamen der Request-/Event-Payloads stammen aus der
Doku-Zusammenfassung, nicht aus einem laufenden Hermes; der Normalisierer ist deshalb tolerant
und reicht Unbekanntes als `unknown` mit Rohdaten durch.
"""
from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator
from typing import Any

import httpx

from .profiles import Profile

# IDs landen in Upstream-Pfaden: nur harmlose Zeichen zulassen (kein "/", kein "..").
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")


class UpstreamError(Exception):
    def __init__(self, status: int, detail: str):
        self.status, self.detail = status, detail
        super().__init__(f"{status}: {detail}")


class HermesClient:
    def __init__(self, profile: Profile, http: httpx.AsyncClient):
        self.profile, self._http = profile, http

    @property
    def _headers(self) -> dict[str, str]:
        h = {"Accept": "application/json"}
        if self.profile.api_key:
            h["Authorization"] = f"Bearer {self.profile.api_key}"
        return h

    def _url(self, path: str) -> str:
        return f"{self.profile.base_url}{path}"

    async def _request(self, method: str, path: str, **kw: Any) -> Any:
        try:
            r = await self._http.request(method, self._url(path), headers=self._headers, **kw)
        except httpx.TimeoutException as e:
            raise UpstreamError(504, "Hermes antwortet nicht rechtzeitig") from e
        except httpx.HTTPError as e:
            raise UpstreamError(502, "Hermes nicht erreichbar") from e
        if r.status_code >= 400:
            raise UpstreamError(r.status_code, _short_detail(r))
        return r.json() if r.content else {}

    # --- Lesen ---------------------------------------------------------------------------
    async def capabilities(self) -> Any:
        return await self._request("GET", "/v1/capabilities")

    async def models(self) -> Any:
        return await self._request("GET", "/api/model/options")

    async def sessions(self, limit: int, offset: int, source: str | None) -> Any:
        params: dict[str, Any] = {"limit": limit, "offset": offset}
        if source:
            params["source"] = source
        return await self._request("GET", "/api/sessions", params=params)

    async def session_messages(self, session_id: str) -> Any:
        return await self._request("GET", f"/api/sessions/{session_id}/messages")

    async def run_status(self, run_id: str) -> Any:
        return await self._request("GET", f"/v1/runs/{run_id}")

    # --- Steuern -------------------------------------------------------------------------
    async def start_run(self, body: dict[str, Any]) -> Any:
        return await self._request("POST", "/v1/runs", json=body)

    async def run_action(self, run_id: str, action: str, body: dict[str, Any]) -> Any:
        assert action in {"stop", "approval", "clarify"}
        return await self._request("POST", f"/v1/runs/{run_id}/{action}", json=body)

    # --- Streaming -----------------------------------------------------------------------
    async def run_events(self, run_id: str) -> AsyncIterator[tuple[str, str]]:
        """Liefert (event, data) des Upstream-SSE-Streams."""
        headers = {**self._headers, "Accept": "text/event-stream"}
        try:
            async with self._http.stream(
                "GET", self._url(f"/v1/runs/{run_id}/events"), headers=headers,
                timeout=httpx.Timeout(10.0, read=None),
            ) as r:
                if r.status_code >= 400:
                    await r.aread()
                    raise UpstreamError(r.status_code, _short_detail(r))
                async for item in parse_sse(r.aiter_lines()):
                    yield item
        except httpx.HTTPError as e:
            raise UpstreamError(502, "Verbindung zu Hermes abgebrochen") from e


def _short_detail(r: httpx.Response) -> str:
    try:
        body = r.json()
        msg = body.get("error", body) if isinstance(body, dict) else body
        if isinstance(msg, dict):
            msg = msg.get("message", msg)
        return str(msg)[:300]
    except ValueError:
        return r.text[:300]


async def parse_sse(lines: AsyncIterator[str]) -> AsyncIterator[tuple[str, str]]:
    event, data = "message", []
    async for line in lines:
        if line == "":
            if data:
                yield event, "\n".join(data)
            event, data = "message", []
        elif line.startswith(":"):
            continue
        elif line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[5:].removeprefix(" "))
    if data:
        yield event, "\n".join(data)


# --- Normalisierung ----------------------------------------------------------------------
def _first(d: dict, *keys: str, default: Any = None) -> Any:
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return default


def normalize_event(name: str, raw: str) -> dict[str, Any]:
    """Bildet ein Upstream-Event auf das stabile Event-Schema des Frontends ab."""
    try:
        data = json.loads(raw)
    except ValueError:
        data = {"text": raw}
    if not isinstance(data, dict):
        data = {"value": data}

    if name in {"assistant.delta", "message.delta"}:
        return {"type": "message.delta", "text": _first(data, "delta", "text", "content", default="")}
    if name in {"reasoning.delta", "thinking.delta"}:
        return {"type": "reasoning.delta", "text": _first(data, "delta", "text", default="")}
    if name == "message.interim":
        return {"type": "message.interim", "text": _first(data, "text", "content", default="")}
    if name == "tool.started":
        return {
            "type": "tool.started",
            "id": str(_first(data, "tool_call_id", "id", default=_first(data, "name", default="tool"))),
            "name": _first(data, "name", "tool", default="tool"),
            "preview": _first(data, "preview", "args", "arguments"),
        }
    if name == "tool.completed":
        return {
            "type": "tool.completed",
            "id": str(_first(data, "tool_call_id", "id", default=_first(data, "name", default="tool"))),
            "name": _first(data, "name", "tool", default="tool"),
            "ok": not bool(_first(data, "error", default=False)) and _first(data, "ok", default=True),
            "duration_ms": _first(data, "duration_ms", "duration"),
            "output": _first(data, "output", "result", "preview"),
        }
    if name in {"approval.requested", "approval.required"}:
        return {
            "type": "approval.requested",
            "approval_id": _first(data, "approval_id", "id"),
            "command": _first(data, "command", default=""),
            "reason": _first(data, "reason", "description", default=""),
            "timeout_s": _first(data, "timeout", "timeout_s", default=300),
        }
    if name in {"clarify.requested", "clarify.required"}:
        return {
            "type": "clarify.requested",
            "clarify_id": _first(data, "clarify_id", "id"),
            "question": _first(data, "question", "prompt", default=""),
            "choices": _first(data, "choices", "options"),
        }
    if name.startswith("subagent."):
        return {"type": name, "id": _first(data, "subagent_id", "id"), "data": data}
    if name == "run.started":
        return {"type": "run.started", "run_id": _first(data, "run_id", "id"), "session_id": data.get("session_id")}
    if name in {"run.completed", "run.finished"}:
        return {"type": "run.completed", "usage": data.get("usage"), "text": _first(data, "output", "text")}
    if name in {"run.failed", "run.error"}:
        return {"type": "run.failed", "error": str(_first(data, "error", "message", default="Run fehlgeschlagen"))[:500]}
    if name in {"run.stopped", "run.cancelled"}:
        return {"type": "run.stopped"}
    return {"type": "unknown", "name": name, "data": data}


TERMINAL_TYPES = {"run.completed", "run.failed", "run.stopped"}
