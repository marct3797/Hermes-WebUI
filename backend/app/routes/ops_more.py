"""Etappe 1 der Abdeckung: Betrieb und Konfiguration, soweit Hermes dafür eine Dashboard-Route anbietet.

Lesen: Checkpoints (nur Sitzungs-ID, Dateizahl, Größe; nie Pfade), Update-Beleg (Kurzfassung), Standardwerte und Roh-YAML der Konfiguration
(Geheimnisse und Serverpfade entfallen). Schreiben, jeweils mit frischer Anmeldung und eingetippter Bestätigung: Checkpoints aufräumen,
Sicherheitsprüfung starten, Gateway leeren (Drain) oder das Leeren abbrechen, OAuth-Anbieter abmelden. Roh-YAML schreiben bleibt aus: das
Schema-Formular ist der geprüfte Weg. Zu alte Hermes-Versionen enden über `DashboardClient` in einer klaren 501.
"""
from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from pydantic import BaseModel, Field

from ..auth import User, current_user, fresh_user
from ..dashboard_ops import clip, redact
from .agents import Tgt, upstream
from .dashboard import Dash, audit
from .hermes_config import scrub

router = APIRouter(prefix="/bff/h/{host}/{runtime}/{agent}", dependencies=[Depends(current_user)])

CHECKPOINTS_PRUNE, SECURITY_AUDIT = "checkpoints-prune", "security-audit"  # feste Aktionsnamen von Hermes
OAuthId = Annotated[str, Path(pattern=r"^[a-z0-9][a-z0-9-]{0,63}$")]
MAX_ROWS = 500


class Confirm(BaseModel):
    model_config = {"extra": "forbid"}
    confirm: str = ""


class DrainIn(BaseModel):
    model_config = {"extra": "forbid"}
    action: Literal["drain", "cancel"]
    confirm: str = ""
    suppress_notification: bool = False


def _limit(request: Request, user: User, what: str) -> None:
    request.app.state.limiter.check(f"{user.id}:{what}")


def _need(req_confirm: str, expected: str, what: str) -> None:
    if req_confirm != expected:
        raise HTTPException(422, f"Zum Bestätigen „{expected}“ eintippen. {what}")


def _int(v: Any) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None


# ---- Checkpoints ----
@router.get("/hermes-ops/checkpoints")
async def checkpoints(target: Tgt, dash: Dash):
    b = await upstream(dash.request("GET", "/api/ops/checkpoints", params={"profile": target.agent.id}))
    rows = b.get("sessions") if isinstance(b, dict) else None
    if not isinstance(rows, list):
        raise HTTPException(502, "Das Dashboard liefert die Checkpoints in unbekannter Form")
    out = [{"session": str(r["session"])[:80], "files": _int(r.get("files")), "bytes": _int(r.get("bytes"))}
           for r in rows[:MAX_ROWS] if isinstance(r, dict) and isinstance(r.get("session"), str)]
    return {"sessions": out, "total_bytes": _int(b.get("total_bytes")), "truncated": len(rows) > MAX_ROWS}


@router.post("/hermes-ops/checkpoints/prune", status_code=202)
async def checkpoints_prune(request: Request, target: Tgt, dash: Dash, req: Confirm, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-ops")
    _need(req.confirm, target.agent.id, "Aufräumen entfernt Wiederherstellungspunkte für /rollback.")
    await upstream(dash.request("POST", "/api/ops/checkpoints/prune", params={"profile": target.agent.id}))
    audit(request, user, "hermes_ops.checkpoints_prune", target)
    return {"ok": True, "action": CHECKPOINTS_PRUNE}


# ---- Sicherheitsprüfung (liest nur, startet einen Hintergrundlauf) ----
@router.post("/hermes-ops/security-audit", status_code=202)
async def security_audit(request: Request, target: Tgt, dash: Dash, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-ops")
    await upstream(dash.request("POST", "/api/ops/security-audit", params={"profile": target.agent.id}))
    audit(request, user, "hermes_ops.security_audit", target)
    return {"ok": True, "action": SECURITY_AUDIT}


@router.get("/hermes-ops/actions/{name}")
async def action_state(target: Tgt, dash: Dash, name: Literal["checkpoints-prune", "security-audit"]):
    b = await upstream(dash.request("GET", f"/api/actions/{name}/status"))
    if not isinstance(b, dict):
        raise HTTPException(502, "Das Dashboard liefert den Aktionszustand in unbekannter Form")
    log = b.get("log") if isinstance(b.get("log"), str) else "\n".join(str(x) for x in b.get("lines") or [])
    return {"action": name, "running": bool(b.get("running")), "exit_code": b.get("exit_code") if isinstance(b.get("exit_code"), int) else None, "log": redact(log)[-4000:]}


# ---- Gateway leeren ----
@router.post("/gateway/drain")
async def gateway_drain(request: Request, target: Tgt, dash: Dash, req: DrainIn, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-ops")
    if req.action == "drain":
        _need(req.confirm, "leeren", "Das Gateway nimmt dann keine neuen Läufe an, bis es neu startet oder das Leeren abgebrochen wird.")
    b = await upstream(dash.request("POST", "/api/gateway/drain", body={"action": req.action, "suppress_notification": req.suppress_notification}))
    if not isinstance(b, dict) or b.get("ok") is not True:
        raise HTTPException(502, "Das Dashboard hat das Leeren nicht bestätigt")
    audit(request, user, f"hermes_ops.gateway_drain_{req.action}", target)
    return {"ok": True, "action": req.action, "was_draining": b.get("was_draining") if isinstance(b.get("was_draining"), bool) else None}


# ---- Update-Beleg ----
@router.get("/hermes-ops/update-receipt")
async def update_receipt(target: Tgt, dash: Dash):
    try:
        b = await upstream(dash.request("GET", "/api/hermes/update/receipt"))
    except HTTPException as e:
        if e.status_code == 404:
            return {"receipt": None}  # kein Update seit Einführung der Belege
        raise
    s = b.get("summary") if isinstance(b, dict) else None
    if not isinstance(s, dict):
        raise HTTPException(502, "Das Dashboard liefert den Update-Beleg in unbekannter Form")
    return {"receipt": {k: clip(v, 200) if isinstance(v, str) else v for k, v in s.items() if isinstance(v, (str, bool, int, float)) and k != "path"}}


# ---- Konfiguration: Standardwerte und Roh-YAML nur lesen ----
@router.get("/hermes-config/defaults")
async def config_defaults(target: Tgt, dash: Dash):
    b = await upstream(dash.request("GET", "/api/config/defaults"))
    if not isinstance(b, dict):
        raise HTTPException(502, "Das Dashboard liefert die Standardwerte in unbekannter Form")
    return {"defaults": scrub(b)}


@router.get("/hermes-config/raw")
async def config_raw(target: Tgt, dash: Dash):
    b = await upstream(dash.request("GET", "/api/config/raw", params={"profile": target.agent.id}))
    text = b.get("yaml") if isinstance(b, dict) else None
    if not isinstance(text, str):
        raise HTTPException(502, "Das Dashboard liefert die Konfiguration in unbekannter Form")
    clean = redact(text)
    return {"yaml": clean[:200_000], "truncated": len(clean) > 200_000, "redacted": clean != text}


# ---- OAuth abmelden ----
@router.delete("/providers/oauth/{provider}")
async def oauth_logout(request: Request, target: Tgt, dash: Dash, provider: OAuthId, req: Confirm, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-ops")
    _need(req.confirm, provider, "Der Agent verliert die Anmeldung bei diesem Anbieter.")
    await upstream(dash.request("DELETE", f"/api/providers/oauth/{provider}", params={"profile": target.agent.id}))
    audit(request, user, "hermes_oauth.logout", target, provider=provider)
    return {"ok": True, "provider": provider}
