"""Runtime-Adapter: eine Schnittstelle für Hermes, OpenCode, Claude Code und Antigravity.

Ein Adapter gehört zu einer Runtime auf einem Host (z. B. Hermes auf server) und kennt alle Pfade,
Feldnamen und Eventnamen dieser Runtime. Nach außen liefert er das gemeinsame Ereignisformat
(`app/events.py`). Was eine Runtime nicht kann, meldet sie als Fähigkeit (`features`) und wirft bei
Aufruf `Unsupported`; das UI blendet es dann aus.

Neue Runtime: Adapter-Klasse schreiben, in `ADAPTER_TYPES` eintragen, Runtime in der Host-Config
nennen. Phase 4 ergänzt OpenCode, Claude Code und Antigravity.
"""
from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Literal

from ..events import Event

AgentState = Literal["online", "auth_error", "unreachable", "gone", "unsupported"]


class UpstreamError(Exception):
    """Fehler der Runtime. `status` ist ein HTTP-Status, den das BFF an den Browser weitergeben darf."""

    def __init__(self, status: int, detail: str):
        self.status, self.detail = status, detail
        super().__init__(f"{status}: {detail}")


class Unsupported(UpstreamError):
    def __init__(self, what: str):
        super().__init__(501, f"Wird von dieser Runtime nicht unterstützt: {what}")


@dataclass(frozen=True)
class RunInput:
    text: str
    session_id: str | None = None
    model: str | None = None
    images: tuple[str, ...] = ()  # Data-URLs, vom BFF bereits geprüft
    idempotency_key: str | None = None  # gleicher Schlüssel = derselbe Run, auch bei doppeltem Absenden


@dataclass(frozen=True)
class RunInfo:
    run_id: str
    session_id: str | None = None


@dataclass(frozen=True)
class Health:
    """Läuft die Runtime auf dem Host? Ohne Zugangsdaten abfragbar."""
    state: Literal["online", "unreachable"]
    version: str | None = None
    detail: str | None = None


@dataclass(frozen=True)
class AgentStatus:
    state: AgentState
    version: str | None = None
    features: frozenset[str] = frozenset()
    error: str | None = None

    def public(self) -> dict[str, Any]:
        return {
            "state": self.state, "online": self.state == "online", "version": self.version,
            "features": sorted(self.features), "error": self.error,
        }


@dataclass(frozen=True)
class AgentInfo:
    id: str
    label: str


class RuntimeAdapter:
    """Basisklasse. Unterklassen überschreiben, was ihre Runtime kann."""

    id: str = ""
    label: str = ""

    def agents(self) -> list[AgentInfo]:
        raise NotImplementedError

    async def health(self) -> Health:
        raise NotImplementedError

    async def probe(self, agent: str) -> AgentStatus:
        raise NotImplementedError

    async def models(self, agent: str) -> Any:
        raise Unsupported("Modellliste")

    async def sessions(self, agent: str, *, limit: int, offset: int, source: str | None, include_children: bool = False) -> Any:
        raise Unsupported("Sessions")

    async def session_messages(self, agent: str, session_id: str, *, limit: int | None = None, offset: int | None = None) -> Any:
        raise Unsupported("Session-Verlauf")

    async def fork_session(self, agent: str, session_id: str) -> Any:
        raise Unsupported("Session abzweigen")

    async def skills(self, agent: str) -> Any:
        raise Unsupported("Skills")

    async def toolsets(self, agent: str) -> Any:
        raise Unsupported("Toolsets")

    async def rename_session(self, agent: str, session_id: str, title: str) -> Any:
        raise Unsupported("Session umbenennen")

    async def delete_session(self, agent: str, session_id: str) -> None:
        raise Unsupported("Session löschen")

    async def start_run(self, agent: str, req: RunInput) -> RunInfo:
        raise Unsupported("Runs")

    async def run_status(self, agent: str, run_id: str) -> Any:
        raise Unsupported("Run-Status")

    async def events(self, agent: str, run_id: str) -> AsyncIterator[Event]:
        """Ereignisse eines Runs im gemeinsamen Format; endet mit einem Event aus TERMINAL_TYPES."""
        raise Unsupported("Ereignisstrom")
        yield  # macht die Methode zum Generator

    async def stop(self, agent: str, run_id: str) -> None:
        raise Unsupported("Stopp")

    async def approve(self, agent: str, run_id: str, decision: str) -> None:
        raise Unsupported("Freigaben")

    async def clarify(self, agent: str, run_id: str, answer: str, clarify_id: str | None) -> None:
        raise Unsupported("Rückfragen")

    async def steer(self, agent: str, run_id: str, text: str) -> None:
        raise Unsupported("Steer")


def adapter_classes() -> dict[str, type[RuntimeAdapter]]:
    """Runtime-Kennung -> Adapter-Klasse. Spät importiert, damit die Module einander nicht zyklisch laden."""
    from .hermes import HermesAdapter

    return {HermesAdapter.id: HermesAdapter}
