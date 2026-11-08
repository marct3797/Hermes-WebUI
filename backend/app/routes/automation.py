"""Ziele (`/goal`), Heartbeats und Schleifen (`/loop`) der Hermes-Sitzungen.

Hermes bietet dafür weder in der Gateway-API noch im Dashboard eine HTTP-Schnittstelle, und `/goal`, `/heartbeat` und `/loop` werden über die API nicht
ausgeführt. Lesen: Der Zustand liegt in der `state.db` des Profils; den Zugriff hat nur der Host-Dienst (`hostd`), und zwar nur lesend.
Ändern (Setzen, Pausieren, Fortsetzen, Löschen): hostd ruft dafür den eigenen Gateway-Client von Hermes auf (`session.automation`), der einzige Schreiber
bleibt der Gateway. Ändern braucht eine frische Anmeldung und ist je Profil in hostd freizuschalten (`allow_automation`).
"""
from __future__ import annotations

from typing import Any

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from ..auth import User, current_user, fresh_user
from ..operations import HostdClient
from .agents import Tgt
from .dashboard import audit

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


class ChangeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: str = Field(pattern=r"^[A-Za-z0-9_.:-]{1,128}$")
    kind: Literal["goal", "heartbeat", "loop"]
    action: Literal["set", "pause", "resume", "clear"]
    text: str | None = Field(default=None, max_length=2000)
    max_turns: int | None = Field(default=None, ge=1, le=1000)
    interval_seconds: int | None = Field(default=None, ge=1, le=604800)


WRITE_ERRORS = {
    404: OLD_HOSTD,
    403: "Ändern ist für dieses Profil nicht freigeschaltet. Setze allow_automation in der hostd-Konfiguration.",
    501: "Der Hermes-Client ist in hostd nicht eingerichtet (native_python).",
    409: "Hermes hat die Änderung abgelehnt, zum Beispiel weil die Sitzung nicht gefunden wurde.",
    422: "Hermes hat die Eingabe abgelehnt, zum Beispiel weil das Intervall zu kurz ist.",
    502: "Der Hermes-Client in hostd hat nicht geantwortet.",
    503: "Der Gateway dieses Profils läuft nicht. hostd startet keinen. Starte ihn und versuche es erneut.",
    504: "Keine Antwort in der Zeit. Das Ergebnis ist unbekannt: lade die Liste neu und prüfe.",
}


@router.post("/automation")
async def change(request: Request, target: Tgt, req: ChangeIn, user: User = Depends(fresh_user)) -> dict[str, Any]:
    request.app.state.limiter.check(f"{user.id}:automation")
    if req.kind == "loop" and req.action == "set":
        raise HTTPException(422, "Schleifen lassen sich nur in Hermes selbst anlegen (/loop)")
    if req.action == "set" and not (req.text or "").strip():
        raise HTTPException(422, "Text fehlt")
    if req.action == "set" and req.kind == "heartbeat" and not req.interval_seconds:
        raise HTTPException(422, "Intervall fehlt")
    try:
        body = await _daemon(request, target.host.id).request("POST", f"/v1/profiles/{target.agent.id}/automation", body=req.model_dump(exclude_none=True), messages=WRITE_ERRORS)
    except HTTPException as exc:
        if exc.status_code in (401, 405):
            raise HTTPException(502, "Der Host-Dienst lehnt die Anfrage ab") from exc
        if exc.status_code == 404:
            raise HTTPException(501, OLD_HOSTD) from exc
        raise
    if not isinstance(body, dict) or body.get("ok") is not True:
        raise HTTPException(502, "Der Host-Dienst liefert die Antwort in einer unbekannten Form")
    audit(request, user, "profile.automation", target, kind=req.kind, change=req.action, session=req.session_id)
    return {"ok": True, "kind": req.kind, "action": req.action, "status": body.get("status"), "started": body.get("started") if isinstance(body.get("started"), bool) else None}
