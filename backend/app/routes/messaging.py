"""Messaging-Plattformen und Gateway-Betrieb eines Hermes-Profils.

Plattformen, Variablen und Zustände kommen vom Dashboard (Hermes kennt über 30). Die WebUI schreibt nur, was die Plattform selbst nennt,
liest jede Änderung zurück und gibt nie einen Token aus. Hermes meldet z. B. ok, wenn die .env gesperrt war und nichts geschrieben wurde;
darum vergleicht das BFF nach dem Schreiben, ob es angekommen ist.

Gateway: Start, Stopp und Neustart melden „gestartet“, nicht „läuft“ (Hermes startet nur einen Prozess); der Zustand steht in `GET .../gateway`.
Der Neustart des Dashboards unterbricht laufende Läufe immer (`--interrupt` ist fest), der Stopp tut es mit `interrupt=true`: beides nur nach
ausdrücklicher Bestätigung, wenn das Gateway beschäftigt ist.

Telegram- und WhatsApp-Onboarding: Hermes legt die Kopplung an, das Bot-Token bzw. die Sitzung bleibt im Dashboard-Prozess
und erreicht nie den Browser. Der Browser zeigt nur QR-Inhalt und Stand.
Nicht vorhanden: Drain (gilt für das Heimatverzeichnis des Dashboards, nicht für ein Profil).
"""
from __future__ import annotations

from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Request
from pydantic import BaseModel, Field

from ..auth import User, current_user, fresh_user
from ..dashboard_ops import clip, redact
from .agents import Tgt, upstream
from .dashboard import Dash, audit
from .hermes_config import SECRET_RE
from .tools import ENV_KEY, _check_value, pick, scope

router = APIRouter(prefix="/bff/h/{host}/{runtime}/{agent}", dependencies=[Depends(current_user)])

Platform = Annotated[str, Path(pattern=r"^[a-z][a-z0-9_]{0,39}$")]
PairingId = Annotated[str, Path(pattern=r"^[A-Za-z0-9_-]{1,100}$")]
MAX_KEYS = 20
GATEWAY_PATH = {"start": "/api/gateway/start", "stop": "/api/gateway/stop", "restart": "/api/gateway/restart"}
TELEGRAM_HOSTS = {"t.me", "telegram.me"}
PLATFORM_FIELDS = ("id", "name", "description", "docs_url", "enabled", "configured", "gateway_running", "state", "error_code")
VAR_FIELDS = ("key", "required", "is_set", "description", "prompt", "url", "is_password", "is_list", "advanced")


class PlatformIn(BaseModel):
    enabled: bool | None = None
    env: dict[str, str] = Field(default_factory=dict, max_length=MAX_KEYS)
    clear_env: list[str] = Field(default_factory=list, max_length=MAX_KEYS)


class Interrupt(BaseModel):
    confirm_interrupt: bool = False


class TelegramStart(BaseModel):
    bot_name: str | None = Field(default=None, min_length=1, max_length=64, pattern=r"^[^\x00-\x1f]+$")


class TelegramApply(BaseModel):
    allowed_user_ids: list[Annotated[str, Field(pattern=r"^\d{1,20}$")]] = Field(min_length=1, max_length=50)


def _limit(request: Request, user: User) -> None:
    request.app.state.limiter.check(f"{user.id}:messaging")


def _var(v: dict[str, Any]) -> dict[str, Any]:
    row = pick(v, VAR_FIELDS)
    for field in ("description", "prompt"):  # Katalogtexte von Hermes („Bot token“): nur kürzen, nicht als Geheimnis schwärzen
        if field in row:
            row[field] = str(row[field] or "")[:300]
    # Klartext nur für Felder, die kein Geheimnis sind (z. B. erlaubte Nutzer); Hermes liefert für Geheimnisse ohnehin nur eine geschwärzte Vorschau.
    if not v.get("is_password") and not SECRET_RE.search(str(v.get("key", ""))) and isinstance(v.get("value"), str):
        row["value"] = clip(v["value"], 500)
    row["is_set"] = bool(row.get("is_set"))
    return row


def _platform(p: dict[str, Any]) -> dict[str, Any]:
    row = pick(p, PLATFORM_FIELDS)
    row["error_message"] = clip(p.get("error_message"), 300) if p.get("error_message") else None
    row["home_channel_set"] = bool(p.get("home_channel"))
    row["env_vars"] = [_var(v) for v in p.get("env_vars", []) if isinstance(v, dict) and isinstance(v.get("key"), str)]
    return row


async def _platforms(target: Tgt, dash: Dash) -> list[dict[str, Any]]:
    body = await upstream(dash.request("GET", "/api/messaging/platforms", params=scope(target)))
    if not isinstance(body, dict) or not isinstance(body.get("platforms"), list):
        raise HTTPException(502, "Das Dashboard liefert die Plattformen in einer unbekannten Form")
    return [_platform(p) for p in body["platforms"] if isinstance(p, dict) and isinstance(p.get("id"), str)]


async def _status(target: Tgt, dash: Dash) -> dict[str, Any]:
    body = await upstream(dash.request("GET", "/api/status", params=scope(target)))
    if not isinstance(body, dict):
        raise HTTPException(502, "Das Dashboard liefert den Gateway-Zustand in einer unbekannten Form")
    return {"running": bool(body.get("gateway_running")), "state": body.get("gateway_state"), "busy": bool(body.get("gateway_busy")),
            "active_sessions": int(body.get("active_sessions") or 0), "version": body.get("version")}


@router.get("/messaging")
async def list_platforms(target: Tgt, dash: Dash):
    return {"platforms": await _platforms(target, dash)}


@router.put("/messaging/{platform}")
async def configure(request: Request, platform: Platform, target: Tgt, dash: Dash, req: PlatformIn, user: User = Depends(fresh_user)):
    _limit(request, user)
    if req.enabled is None and not req.env and not req.clear_env:
        raise HTTPException(422, "Nichts zu ändern")
    row = next((p for p in await _platforms(target, dash) if p["id"] == platform), None)
    if row is None:
        raise HTTPException(404, "Unbekannte Plattform")
    declared = {v["key"] for v in row["env_vars"]}
    for key in [*req.env, *req.clear_env]:
        if not ENV_KEY.match(key):
            raise HTTPException(422, f"{key}: ungültiger Variablenname")
        if key not in declared:
            raise HTTPException(422, f"{key}: gehört nicht zu den Variablen dieser Plattform")
    values = {k: _check_value(k, v) for k, v in req.env.items()}
    send = {k: v for k, v in values.items() if v}
    clear = sorted(set(req.clear_env) - set(send))
    if send or clear or req.enabled is not None:
        await upstream(dash.request("PUT", f"/api/messaging/platforms/{platform}", body={"enabled": req.enabled, "env": send, "clear_env": clear, "profile": target.agent.id}, params=scope(target)))
        after = next((p for p in await _platforms(target, dash) if p["id"] == platform), {"env_vars": [], "enabled": None})
        now = {v["key"]: v["is_set"] for v in after["env_vars"]}
        wrong = sorted([k for k in send if not now.get(k)] + [k for k in clear if now.get(k)] + (["enabled"] if req.enabled is not None and after["enabled"] != req.enabled else []))
        if wrong:
            raise HTTPException(502, "Das Dashboard hat nicht übernommen: " + ", ".join(wrong))
        audit(request, user, "messaging.config", target, platform=platform, keys=sorted(send), cleared=clear, enabled=req.enabled)
    return {"ok": True, "platform": platform, "needs_restart": True}


@router.post("/messaging/{platform}/test")
async def test_platform(platform: Platform, target: Tgt, dash: Dash):
    body = await upstream(dash.request("POST", f"/api/messaging/platforms/{platform}/test", params=scope(target)))
    if not isinstance(body, dict):
        raise HTTPException(502, "Das Dashboard liefert das Prüfergebnis in einer unbekannten Form")
    return {"ok": bool(body.get("ok")), "state": body.get("state"), "message": clip(body.get("message"), 400), "auth_posture": body.get("auth_posture")}


# --- Gateway -------------------------------------------------------------------------------------------
@router.get("/gateway")
async def gateway_status(target: Tgt, dash: Dash):
    return await _status(target, dash)


async def _gateway(request: Request, what: Literal["start", "stop", "restart"], target: Tgt, dash: Dash, user: User, confirmed: bool):
    _limit(request, user)
    status = await _status(target, dash)
    live = status["busy"] or status["active_sessions"] > 0
    interrupt = False
    if what != "start" and live:
        if not confirmed:
            n = status["active_sessions"]
            raise HTTPException(409, {"code": "interrupt_confirmation_required", "active_sessions": n, "busy": status["busy"],
                                      "message": f"Das Gateway ist beschäftigt ({n} laufende Sitzung(en)). {'Der Neustart' if what == 'restart' else 'Das Anhalten'} unterbricht sie."})
        interrupt = True
    params = scope(target) | ({"interrupt": "true"} if what == "stop" and interrupt else {})
    await upstream(dash.request("POST", GATEWAY_PATH[what], params=params))
    audit(request, user, f"gateway.{what}", target, interrupted=interrupt, active_sessions=status["active_sessions"])
    return {"ok": True, "started": True, "action": f"gateway-{what}", "interrupted": interrupt}


@router.post("/gateway/start")
async def gateway_start(request: Request, target: Tgt, dash: Dash, user: User = Depends(fresh_user)):
    return await _gateway(request, "start", target, dash, user, False)


@router.post("/gateway/stop")
async def gateway_stop(request: Request, target: Tgt, dash: Dash, req: Annotated[Interrupt, Body()] = Interrupt(), user: User = Depends(fresh_user)):
    return await _gateway(request, "stop", target, dash, user, req.confirm_interrupt)


@router.post("/gateway/restart")
async def gateway_restart(request: Request, target: Tgt, dash: Dash, req: Annotated[Interrupt, Body()] = Interrupt(), user: User = Depends(fresh_user)):
    return await _gateway(request, "restart", target, dash, user, req.confirm_interrupt)


@router.get("/gateway/actions/{name}")
async def gateway_action(name: Literal["gateway-start", "gateway-stop", "gateway-restart"], target: Tgt, dash: Dash):
    body = await upstream(dash.request("GET", f"/api/actions/{name}/status", params={"lines": "200"}))
    if not isinstance(body, dict):
        raise HTTPException(502, "Das Dashboard liefert den Verlauf in einer unbekannten Form")
    lines = body.get("lines") if isinstance(body.get("lines"), list) else []
    return {"name": name, "running": bool(body.get("running")), "exit_code": body.get("exit_code"), "lines": [redact(str(x))[:300] for x in lines[-200:]]}


# --- Telegram-Onboarding -------------------------------------------------------------------------------
def _telegram_link(link: Any) -> str:
    u = urlsplit(link) if isinstance(link, str) else None
    if u is None or u.scheme != "https" or u.hostname not in TELEGRAM_HOSTS or u.username or u.password:
        raise HTTPException(502, "Hermes lieferte keine Telegram-Adresse")
    return link


@router.post("/messaging/telegram/onboarding")
async def telegram_start(request: Request, target: Tgt, dash: Dash, req: TelegramStart, user: User = Depends(fresh_user)):
    _limit(request, user)
    body = await upstream(dash.request("POST", "/api/messaging/telegram/onboarding/start", body={"bot_name": req.bot_name} if req.bot_name else {}))
    if not isinstance(body, dict) or not isinstance(body.get("pairing_id"), str):
        raise HTTPException(502, "Das Dashboard liefert die Kopplung in einer unbekannten Form")
    audit(request, user, "messaging.onboarding.start", target, platform="telegram")
    return {"pairing_id": body["pairing_id"], "suggested_username": clip(body.get("suggested_username"), 64), "deep_link": _telegram_link(body.get("deep_link")), "expires_at": body.get("expires_at")}


@router.get("/messaging/telegram/onboarding/{pairing_id}")
async def telegram_poll(pairing_id: PairingId, target: Tgt, dash: Dash):
    body = await upstream(dash.request("GET", f"/api/messaging/telegram/onboarding/{pairing_id}", missing="Die Telegram-Kopplung ist abgelaufen. Bitte neu beginnen."))
    if not isinstance(body, dict) or body.get("status") not in ("waiting", "ready"):
        raise HTTPException(502, "Das Dashboard liefert den Stand der Kopplung in einer unbekannten Form")
    out = pick(body, ("status", "expires_at"))
    if body["status"] == "ready":
        out["bot_username"] = clip(body.get("bot_username"), 64) or None
        owner = body.get("owner_user_id")
        out["owner_user_id"] = owner if isinstance(owner, str) and owner.isdigit() else None
    return out


@router.post("/messaging/telegram/onboarding/{pairing_id}/apply")
async def telegram_apply(request: Request, pairing_id: PairingId, target: Tgt, dash: Dash, req: TelegramApply, user: User = Depends(fresh_user)):
    _limit(request, user)
    ids = list(dict.fromkeys(req.allowed_user_ids))
    body = await upstream(dash.request("POST", f"/api/messaging/telegram/onboarding/{pairing_id}/apply", body={"allowed_user_ids": ids, "profile": target.agent.id}, params=scope(target),
                                       missing="Die Telegram-Kopplung ist abgelaufen. Bitte neu beginnen."))
    if not isinstance(body, dict) or not body.get("ok"):
        raise HTTPException(502, "Das Dashboard hat die Kopplung nicht übernommen")
    audit(request, user, "messaging.onboarding.apply", target, platform="telegram", allowed_users=len(ids), restart_started=bool(body.get("restart_started")))
    return {"ok": True, "platform": "telegram", "bot_username": clip(body.get("bot_username"), 64) or None, "needs_restart": bool(body.get("needs_restart")),
            "restart_started": bool(body.get("restart_started")), "restart_error": clip(body.get("restart_error"), 200) or None}


@router.delete("/messaging/telegram/onboarding/{pairing_id}")
async def telegram_cancel(pairing_id: PairingId, target: Tgt, dash: Dash):
    await upstream(dash.request("DELETE", f"/api/messaging/telegram/onboarding/{pairing_id}"))
    return {"ok": True}


# --- WhatsApp-Kopplung (QR im Browser statt Terminal) ---------------------------------------------------

class WhatsAppStart(BaseModel):
    mode: str = Field(min_length=1, max_length=32)
    allowed_users: list[str] = Field(default_factory=list, max_length=50)
    reset_session: bool = False


class WhatsAppApply(BaseModel):
    mode: str | None = Field(default=None, min_length=1, max_length=32)
    allowed_users: list[str] | None = Field(default=None, max_length=50)


@router.post("/messaging/whatsapp/onboarding")
async def whatsapp_start(request: Request, target: Tgt, dash: Dash, req: WhatsAppStart, user: User = Depends(fresh_user)):
    """WhatsApp-Kopplung starten: Hermes legt eine Sitzung an, der Browser zeigt den QR-Inhalt zum Scannen."""
    _limit(request, user)
    body = await upstream(dash.request("POST", "/api/messaging/whatsapp/onboarding/start",
                                       body={"mode": req.mode, "allowed_users": req.allowed_users,
                                             "reset_session": req.reset_session, "profile": target.agent.id}, params=scope(target)))
    if not isinstance(body, dict) or not isinstance(body.get("pairing_id"), str):
        raise HTTPException(502, "Das Dashboard liefert die Kopplung in einer unbekannten Form")
    if body.get("status") not in ("waiting", "connected", "pairing", "qr", "ready", "error"):
        raise HTTPException(502, "Das Dashboard liefert den Kopplungsstand in einer unbekannten Form")
    audit(request, user, "messaging.whatsapp.start", target, mode=req.mode)
    return {"pairing_id": body["pairing_id"], "status": body.get("status"), "qr_payload": clip(body.get("qr_payload"), 4096),
            "expires_at": body.get("expires_at"), "mode": body.get("mode"),
            "account": {k: clip(body.get(k), 64) or None for k in ("account_id", "account_name", "account_phone")},
            "error": clip(body.get("error"), 300) or None}


@router.get("/messaging/whatsapp/onboarding/{pairing_id}")
async def whatsapp_poll(pairing_id: PairingId, target: Tgt, dash: Dash):
    body = await upstream(dash.request("GET", f"/api/messaging/whatsapp/onboarding/{pairing_id}", params=scope(target),
                                       missing="Die WhatsApp-Kopplung ist abgelaufen. Bitte neu beginnen."))
    if not isinstance(body, dict) or not isinstance(body.get("status"), str):
        raise HTTPException(502, "Das Dashboard liefert den Stand der Kopplung in einer unbekannten Form")
    return {"status": body.get("status"), "qr_payload": clip(body.get("qr_payload"), 4096), "expires_at": body.get("expires_at"),
            "account": {k: clip(body.get(k), 64) or None for k in ("account_id", "account_name", "account_phone")},
            "error": clip(body.get("error"), 300) or None}


@router.post("/messaging/whatsapp/onboarding/{pairing_id}/apply")
async def whatsapp_apply(request: Request, pairing_id: PairingId, target: Tgt, dash: Dash, req: WhatsAppApply, user: User = Depends(fresh_user)):
    _limit(request, user)
    payload: dict[str, Any] = {"profile": target.agent.id}
    if req.mode is not None:
        payload["mode"] = req.mode
    if req.allowed_users is not None:
        payload["allowed_users"] = req.allowed_users
    body = await upstream(dash.request("POST", f"/api/messaging/whatsapp/onboarding/{pairing_id}/apply", body=payload, params=scope(target),
                                       missing="Die WhatsApp-Kopplung ist abgelaufen. Bitte neu beginnen."))
    if not isinstance(body, dict) or not body.get("ok", True):
        raise HTTPException(502, "Das Dashboard hat die Kopplung nicht übernommen")
    audit(request, user, "messaging.whatsapp.apply", target)
    return {"ok": True, "platform": "whatsapp"}


@router.delete("/messaging/whatsapp/onboarding/{pairing_id}")
async def whatsapp_cancel(pairing_id: PairingId, target: Tgt, dash: Dash):
    await upstream(dash.request("DELETE", f"/api/messaging/whatsapp/onboarding/{pairing_id}", params=scope(target)))
    return {"ok": True}
