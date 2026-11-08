"""Ziele (`/goal`), Heartbeats und Schleifen (`/loop`) der Hermes-Sitzungen, nur lesend.

Hermes bietet dafür weder in der Gateway-API noch im Dashboard eine Schnittstelle, und `/goal`, `/heartbeat` und `/loop` werden über die API nicht
ausgeführt. Der Zustand liegt in der `state.db` des Profils; den Zugriff hat nur der Host-Dienst (`hostd`), und zwar nur lesend. Setzen, pausieren
und löschen geht deshalb ausschließlich in Hermes selbst (Terminal, Desktop, Messaging).
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from ..auth import current_user
from ..operations import HostdClient
from .agents import Tgt

router = APIRouter(prefix="/bff/h/{host}/{runtime}/{agent}", dependencies=[Depends(current_user)])

OLD_HOSTD = "Der Host-Dienst ist zu alt für Ziele und Schleifen. Aktualisiere hostd auf dem Rechner."
KINDS = ("goal", "heartbeat", "loop")


def _daemon(request: Request, host: str) -> HostdClient:
    from .operations import daemon
    return daemon(request, host)


@router.get("/automation")
async def automation(request: Request, target: Tgt) -> dict[str, Any]:
    try:
        body = await _daemon(request, target.host.id).request("GET", f"/v1/profiles/{target.agent.id}/automation")
    except HTTPException as exc:
        if exc.status_code == 404:
            raise HTTPException(501, OLD_HOSTD) from exc
        if exc.status_code in (401, 403):
            raise HTTPException(502, "Der Host-Dienst lehnt die Anfrage ab") from exc
        raise
    items = body.get("items") if isinstance(body, dict) else None
    if not isinstance(items, list):
        raise HTTPException(502, "Der Host-Dienst liefert Ziele und Schleifen in einer unbekannten Form")
    clean = [i for i in items if isinstance(i, dict) and i.get("kind") in KINDS and isinstance(i.get("session_id"), str)]
    return {"items": clean, "truncated": bool(body.get("truncated")), "available": bool(body.get("available", True)),
            "reason": body.get("reason") if isinstance(body.get("reason"), str) else None}
