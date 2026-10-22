"""Gemeinsames Ereignisformat aller Runtime-Adapter.

Jedes Event ist ein Dict mit dem Feld `type` plus den hier aufgeführten Feldern. Das Frontend kennt
nur dieses Format (siehe frontend/src/types.ts); Runtime-Eigenheiten bleiben im jeweiligen Adapter.
"""
from __future__ import annotations

from typing import Any

Event = dict[str, Any]

# type -> Pflichtfelder (zusätzlich zu `type`). Optionale Felder stehen in den Adaptern.
REQUIRED_FIELDS: dict[str, tuple[str, ...]] = {
    "run.started": (),
    "message.delta": ("text",),
    "message.interim": ("text",),
    "reasoning.delta": ("text",),
    "tool.started": ("id", "name"),
    "tool.completed": ("id", "name", "ok"),
    "approval.requested": ("command", "reason", "choices", "timeout_s"),
    "approval.responded": ("choice", "resolved"),
    "clarify.requested": ("question",),
    "run.steered": ("accepted",),
    "subagent.started": ("data",),
    "subagent.completed": ("data",),
    "run.completed": (),
    "run.failed": ("error",),
    "run.stopped": (),
    "stream.error": ("error",),
    "unknown": ("name", "data"),
}

# Danach kommt nichts mehr. `stream.error` erzeugt das BFF selbst, wenn die Verbindung abreißt.
TERMINAL_TYPES = frozenset({"run.completed", "run.failed", "run.stopped", "stream.error"})


def validate_event(ev: Event) -> None:
    """Prüft ein Adapter-Event gegen das gemeinsame Format. Wirft ValueError bei Abweichungen."""
    kind = ev.get("type")
    if kind not in REQUIRED_FIELDS:
        raise ValueError(f"Unbekannter Ereignistyp: {kind!r}")
    missing = [f for f in REQUIRED_FIELDS[kind] if f not in ev]
    if missing:
        raise ValueError(f"{kind}: Felder fehlen: {', '.join(missing)}")
