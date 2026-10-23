"""Hermes-Adapter (API-Server mit Runs, SSE, Approvals, Sessions).

Alles, was Hermes-Routen, Feldnamen oder Eventnamen kennt, steht in dieser Datei. Grundlage ist die
Quelltext-Lesung von 2026-10-22 (Hermes 0.20.4, siehe Fakten-Datei im Projekt), noch kein Lauf mit
Key. Abweichungen zeigen sich als `unknown`-Events oder als Probe-Fehler und werden hier behoben.

Ein Gateway bedient mehrere Profile (`multiplex_profiles`): jede Route gibt es zusätzlich unter
`/p/<profil>/…`. Ohne Multiplex wird das Präfix ignoriert und es gilt das Default-Profil.
"""
from __future__ import annotations

import json
from collections import defaultdict, deque
from collections.abc import AsyncIterator
from typing import Any

import httpx

from ..events import Event
from ..registry import RuntimeCfg
from . import (AgentInfo, AgentStatus, Health, RunInfo, RunInput, RuntimeAdapter, UpstreamError)

DECISIONS = ("once", "session", "always", "deny")
DEFAULT_APPROVAL_TIMEOUT_S = 300  # Hermes lässt Freigabe-Anfragen nach 300 s verfallen
# Was ein Hermes-API-Server laut Quelltext kann. Die Capability-Probe nimmt davon weg oder fügt hinzu.
BASE_FEATURES = frozenset({"runs", "stream", "stop", "approval", "steer", "sessions", "models", "images"})


class HermesAdapter(RuntimeAdapter):
    id = "hermes"
    label = "Hermes"

    def __init__(self, cfg: RuntimeCfg, http: httpx.AsyncClient, health_timeout: float = 2.0):
        self.cfg, self._http, self._health_timeout = cfg, http, health_timeout

    # --- Agents ----------------------------------------------------------------------------
    def agents(self) -> list[AgentInfo]:
        # Phase 0: feste Liste aus der Config. Auto-Erkennung folgt, sobald der Datenordner im
        # Container lesbar ist (Profilordner) oder ein Dashboard die Container-Profile kennt.
        return [AgentInfo(a.id, a.label) for a in self.cfg.agents]

    # --- HTTP-Grundlagen ----------------------------------------------------------------------
    def _url(self, agent: str, path: str) -> str:
        prefix = f"/p/{agent}" if self.cfg.multiplex else ""
        return f"{self.cfg.base_url}{prefix}{path}"

    def _headers(self, agent: str, accept: str = "application/json") -> dict[str, str]:
        # Im Multiplex-Gateway hat jedes Profil sein eigenes API_SERVER_KEY: der Key des Agents geht vor.
        key = next((a.api_key for a in self.cfg.agents if a.id == agent and a.api_key), "") or self.cfg.api_key
        h = {"Accept": accept}
        if key:
            h["Authorization"] = f"Bearer {key}"
        return h

    async def _request(self, method: str, agent: str, path: str, **kw: Any) -> Any:
        try:
            r = await self._http.request(method, self._url(agent, path), headers=self._headers(agent), **kw)
        except httpx.TimeoutException as e:
            raise UpstreamError(504, "Hermes antwortet nicht rechtzeitig") from e
        except httpx.HTTPError as e:
            raise UpstreamError(502, "Hermes nicht erreichbar") from e
        if r.status_code >= 400:
            raise UpstreamError(r.status_code, _short_detail(r))
        return r.json() if r.content else {}

    # --- Gesundheit und Fähigkeiten -------------------------------------------------------------
    async def health(self) -> Health:
        """`GET /health` braucht keinen Key und nennt die Version."""
        try:
            r = await self._http.get(
                f"{self.cfg.base_url}/health", headers={"Accept": "application/json"},
                timeout=self._health_timeout,
            )
            body = r.json() if r.status_code == 200 else {}
        except (httpx.HTTPError, ValueError):
            return Health("unreachable", detail="Hermes nicht erreichbar")
        if r.status_code != 200 or not isinstance(body, dict):
            return Health("unreachable", detail=f"Unerwartete Antwort ({r.status_code})")
        version = body.get("version")
        return Health("online", version=str(version) if version else None)

    async def probe(self, agent: str) -> AgentStatus:
        health = await self.health()
        if health.state != "online":
            return AgentStatus("unreachable", error=health.detail)
        try:
            caps = await self._request("GET", agent, "/v1/capabilities")
        except UpstreamError as e:
            if e.status in (401, 403):
                return AgentStatus("auth_error", health.version, error="Key abgelehnt oder fehlt")
            if e.status == 404:
                # Mit Multiplex heißt 404: Das Profil gibt es nicht (mehr). Ohne: ältere Version.
                state = "gone" if self.cfg.multiplex else "unsupported"
                return AgentStatus(state, health.version, error="Profil unbekannt" if state == "gone" else e.detail)
            return AgentStatus("unreachable", health.version, error=e.detail)
        return AgentStatus("online", health.version, features_from_capabilities(caps))

    # --- Lesen ------------------------------------------------------------------------------
    async def models(self, agent: str) -> Any:
        return await self._request("GET", agent, "/api/model/options")

    async def sessions(self, agent: str, *, limit: int, offset: int, source: str | None) -> Any:
        params: dict[str, Any] = {"limit": limit, "offset": offset}
        if source:
            params["source"] = source
        return await self._request("GET", agent, "/api/sessions", params=params)

    async def session_messages(self, agent: str, session_id: str) -> Any:
        return await self._request("GET", agent, f"/api/sessions/{session_id}/messages")

    async def run_status(self, agent: str, run_id: str) -> Any:
        return await self._request("GET", agent, f"/v1/runs/{run_id}")

    # --- Steuern ----------------------------------------------------------------------------
    async def start_run(self, agent: str, req: RunInput) -> RunInfo:
        body: dict[str, Any] = {}
        if req.images:
            parts: list[dict[str, Any]] = [{"type": "text", "text": req.text}]
            parts += [{"type": "image_url", "image_url": {"url": u}} for u in req.images]
            body["input"] = [{"role": "user", "content": parts}]
        else:
            body["input"] = req.text
        if req.session_id:
            body["session_id"] = req.session_id
        if req.model:
            body["model"] = req.model
        data = await self._request("POST", agent, "/v1/runs", json=body)
        run_id = data.get("run_id") if isinstance(data, dict) else None
        if not run_id:
            raise UpstreamError(502, "Hermes lieferte keine run_id")
        session_id = data.get("session_id") or req.session_id
        if not session_id:
            # Hermes 0.21.6 nennt die Session nicht in der Antwort auf POST /v1/runs, sondern im Lauf-Status.
            # Ohne sie begänne jede Folgenachricht eine neue Session.
            try:
                status = await self._request("GET", agent, f"/v1/runs/{run_id}")
            except UpstreamError:
                status = {}
            found = status.get("session_id") if isinstance(status, dict) else None
            session_id = found if isinstance(found, str) and found else None
        return RunInfo(str(run_id), session_id)

    async def stop(self, agent: str, run_id: str) -> None:
        await self._request("POST", agent, f"/v1/runs/{run_id}/stop", json={})

    async def approve(self, agent: str, run_id: str, decision: str) -> None:
        # Hermes erwartet `choice`; die erlaubten Werte stehen im Event unter `choices`.
        await self._request("POST", agent, f"/v1/runs/{run_id}/approval", json={"choice": decision})

    async def clarify(self, agent: str, run_id: str, answer: str, clarify_id: str | None) -> None:
        # Laut Doku-Zusammenfassung vorhanden, im Quelltext nicht belegt: Phase 1 prüft Route und Body.
        body = {"answer": answer, **({"clarify_id": clarify_id} if clarify_id else {})}
        await self._request("POST", agent, f"/v1/runs/{run_id}/clarify", json=body)

    async def steer(self, agent: str, run_id: str, text: str) -> None:
        await self._request("POST", agent, f"/v1/runs/{run_id}/steer", json={"input": text})

    # --- Ereignisstrom ----------------------------------------------------------------------------
    async def events(self, agent: str, run_id: str) -> AsyncIterator[Event]:
        """Hermes sendet reine `data:`-Frames ohne `event:`-Zeile; der Name steckt im JSON-Feld `event`.

        Der Strom ist nur einmal abonnierbar. Danach hilft `run_status`.
        """
        translator = HermesEventTranslator(run_id)
        headers = self._headers(agent, "text/event-stream")
        try:
            async with self._http.stream(
                "GET", self._url(agent, f"/v1/runs/{run_id}/events"), headers=headers,
                timeout=httpx.Timeout(10.0, read=None),
            ) as r:
                if r.status_code >= 400:
                    await r.aread()
                    raise UpstreamError(r.status_code, _short_detail(r))
                # Hermes sendet kein run.started auf diesem Strom; wir melden den Beginn selbst,
                # erst nachdem die Verbindung steht (Fehler wie 404 kommen so vor dem ersten Event).
                yield {"type": "run.started", "run_id": run_id}
                async for frame_name, raw in parse_sse(r.aiter_lines()):
                    yield translator.translate(frame_name, raw)
        except httpx.HTTPError as e:
            raise UpstreamError(502, "Verbindung zu Hermes abgebrochen") from e


def features_from_capabilities(caps: Any) -> frozenset[str]:
    """Basis-Fähigkeiten minus ausdrücklich abgeschaltete plus ausdrücklich eingeschaltete Flags.

    Die genaue Form von `/v1/capabilities` ist noch nicht gegen eine laufende Instanz geprüft.
    Erwartet wird ein Dict von Flags, optional unter `features`.
    """
    flags = caps.get("features", caps) if isinstance(caps, dict) else {}
    if not isinstance(flags, dict):
        flags = {}
    on = {k for k, v in flags.items() if v is True}
    off = {k for k, v in flags.items() if v is False}
    return frozenset((BASE_FEATURES - off) | on)


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
    """Liefert (Name, Daten) je Frame. Der Name kommt aus `event:`, sonst bleibt er leer."""
    event, data = "", []
    async for line in lines:
        if line == "":
            if data:
                yield event, "\n".join(data)
            event, data = "", []
        elif line.startswith(":"):
            continue  # Keepalive und "stream closed"
        elif line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[5:].removeprefix(" "))
    if data:
        yield event, "\n".join(data)


class HermesEventTranslator:
    """Übersetzt Hermes-Events ins gemeinsame Format. Hält Zustand je Stream (Tool-Zuordnung)."""

    def __init__(self, run_id: str):
        self._run_id = run_id
        self._open_tools: dict[str, deque[str]] = defaultdict(deque)
        self._seq = 0

    def _tool_id(self, data: dict, name: str, starting: bool) -> str:
        explicit = data.get("tool_call_id") or data.get("call_id") or data.get("id")
        if explicit:
            return str(explicit)
        # Hermes nennt keine ID: gleichnamige Aufrufe werden der Reihe nach zugeordnet.
        if starting:
            self._seq += 1
            tid = f"{self._run_id}:{self._seq}"
            self._open_tools[name].append(tid)
            return tid
        if self._open_tools[name]:
            return self._open_tools[name].popleft()
        self._seq += 1
        return f"{self._run_id}:{self._seq}"

    def translate(self, frame_name: str, raw: str) -> Event:
        try:
            data = json.loads(raw)
        except ValueError:
            data = {"text": raw}
        if not isinstance(data, dict):
            data = {"value": data}
        name = str(data.get("event") or frame_name or "")

        match name:
            case "message.delta":
                return {"type": "message.delta", "text": _text(data, "delta", "text")}
            case "message.interim":
                return {"type": "message.interim", "text": _text(data, "text", "content")}
            case "reasoning.available":
                return {"type": "reasoning.delta", "text": _text(data, "text", "delta")}
            case "tool.started":
                tool = str(data.get("tool") or data.get("name") or "tool")
                return {"type": "tool.started", "id": self._tool_id(data, tool, True), "name": tool,
                        "preview": data.get("preview")}
            case "tool.completed":
                tool = str(data.get("tool") or data.get("name") or "tool")
                return {"type": "tool.completed", "id": self._tool_id(data, tool, False), "name": tool,
                        "ok": not bool(data.get("error")), "duration_ms": _millis(data.get("duration"))}
            case "approval.request":
                return {
                    "type": "approval.requested",
                    "command": str(data.get("command", "")),
                    "reason": str(data.get("description") or ""),
                    "choices": _choices(data.get("choices"), bool(data.get("smart_denied"))),
                    "timeout_s": DEFAULT_APPROVAL_TIMEOUT_S,
                    "pattern_key": data.get("pattern_key"),
                    "smart_denied": bool(data.get("smart_denied")),
                }
            case "approval.responded":
                return {"type": "approval.responded", "choice": data.get("choice"), "resolved": data.get("resolved")}
            case "clarify.request":
                # Eventname vermutet (Quelltext zeigt keinen Clarify-Event): Phase 1 prüft ihn am laufenden Hermes.
                return {"type": "clarify.requested", "clarify_id": data.get("clarify_id") or data.get("id"),
                        "question": str(data.get("question") or data.get("prompt") or ""),
                        "choices": data.get("choices")}
            case "run.steered":
                return {"type": "run.steered", "accepted": bool(data.get("accepted"))}
            case "subagent.start":
                return {"type": "subagent.started", "id": data.get("subagent_id"), "data": _without_event(data)}
            case "subagent.complete":
                return {"type": "subagent.completed", "id": data.get("subagent_id"), "data": _without_event(data)}
            case "run.completed":
                ev: Event = {"type": "run.completed", "usage": _usage(data.get("usage")), "text": data.get("output")}
                if data.get("pending_steer"):
                    ev["pending_steer"] = str(data["pending_steer"])
                return ev
            case "run.failed":
                return {"type": "run.failed", "error": str(data.get("error") or "Run fehlgeschlagen")[:500]}
            case "run.cancelled":
                return {"type": "run.stopped"}
        return {"type": "unknown", "name": name, "data": _without_event(data)}


def _text(data: dict, *keys: str) -> str:
    for k in keys:
        v = data.get(k)
        if isinstance(v, str):
            return v
    return ""


def _millis(seconds: Any) -> int | None:
    return round(seconds * 1000) if isinstance(seconds, (int, float)) and not isinstance(seconds, bool) else None


def _choices(raw: Any, smart_denied: bool) -> list[str]:
    """Erlaubte Entscheidungen aus dem Event; fehlt die Liste, gilt die vorsichtigste Auswahl."""
    if isinstance(raw, list):
        picked = [c for c in raw if c in DECISIONS]
        if picked:
            return picked
    return ["once", "deny"] if smart_denied or raw is None else ["deny"]


def _usage(raw: Any) -> dict[str, int] | None:
    if not isinstance(raw, dict):
        return None
    return {k: raw[k] for k in ("input_tokens", "output_tokens", "total_tokens")
            if isinstance(raw.get(k), int) and not isinstance(raw.get(k), bool)}


def _without_event(data: dict) -> dict:
    return {k: v for k, v in data.items() if k != "event"}
