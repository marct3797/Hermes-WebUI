"""Pairing und Webhooks (Punkt 10). Schranken siehe tests/test_hermes_access.py.

Nicht durchgereicht: Hooks (`/api/ops/hooks` führen Shell-Befehle aus), Webhook-`script` und eigene Secrets, Pairing per Code,
`pairing/clear-pending`.
"""
from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field, field_validator

from ..auth import User, current_user, fresh_user
from .agents import Tgt, upstream
from .dashboard import Dash, audit

router = APIRouter(prefix="/bff/h/{host}/{runtime}/{agent}", dependencies=[Depends(current_user)])

NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
PLATFORM = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
USER_ID = re.compile(r"^[\w.:@+-]{1,128}$")
REQ_ID = re.compile(r"^[\w.:-]{1,128}$")


def _limit(request: Request, user: User, what: str) -> None:
    request.app.state.limiter.check(f"{user.id}:{what}")


def _match(rx: re.Pattern[str], what: str):
    def check(v: str) -> str:
        if not rx.match(v):
            raise ValueError(f"{what}: ungültige Zeichen")
        return v
    return check


async def _pairing(dash: Dash, agent: str) -> dict[str, list[dict[str, Any]]]:
    b = await upstream(dash.request("GET", "/api/pairing", params={"profile": agent}))
    if not isinstance(b, dict) or not isinstance(b.get("pending"), list) or not isinstance(b.get("approved"), list):
        raise HTTPException(502, "Das Dashboard liefert die Freigaben in unbekannter Form")
    pend = [{k: p.get(k, "") for k in ("platform", "request_id", "user_id", "user_name", "age_minutes")} for p in b["pending"] if isinstance(p, dict)]
    appr = [{k: a.get(k, "") for k in ("platform", "user_id", "user_name", "approved_at")} for a in b["approved"] if isinstance(a, dict)]
    return {"pending": pend, "approved": appr}


@router.get("/hermes-pairing")
async def pairing_read(target: Tgt, dash: Dash):
    return await _pairing(dash, target.agent.id)


class ApproveIn(BaseModel):
    model_config = {"extra": "forbid"}  # kein `code`: Raten über die Oberfläche bleibt aus
    platform: str
    request_id: str

    _p = field_validator("platform")(_match(PLATFORM, "Plattform"))
    _r = field_validator("request_id")(_match(REQ_ID, "Anfrage-ID"))


@router.post("/hermes-pairing/approve")
async def pairing_approve(request: Request, target: Tgt, dash: Dash, req: ApproveIn, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-access")
    await upstream(dash.request("POST", "/api/pairing/approve", body={"platform": req.platform, "request_id": req.request_id, "profile": target.agent.id}))
    after = await _pairing(dash, target.agent.id)
    if any(p["request_id"] == req.request_id and p["platform"] == req.platform for p in after["pending"]):
        raise HTTPException(502, "Das Dashboard hat die Anfrage nicht freigegeben")
    audit(request, user, "pairing.approve", target, platform=req.platform, request_id=req.request_id)
    return {"ok": True, **after}


class RevokeIn(BaseModel):
    model_config = {"extra": "forbid"}
    platform: str
    user_id: str
    confirm: str

    _p = field_validator("platform")(_match(PLATFORM, "Plattform"))
    _u = field_validator("user_id")(_match(USER_ID, "Nutzer-ID"))


@router.post("/hermes-pairing/revoke")
async def pairing_revoke(request: Request, target: Tgt, dash: Dash, req: RevokeIn, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-access")
    if req.confirm != req.user_id:
        raise HTTPException(422, "Sperren: die Nutzer-ID zur Bestätigung eingeben")
    await upstream(dash.request("POST", "/api/pairing/revoke", body={"platform": req.platform, "user_id": req.user_id, "profile": target.agent.id}))
    after = await _pairing(dash, target.agent.id)
    if any(a["user_id"] == req.user_id and a["platform"] == req.platform for a in after["approved"]):
        raise HTTPException(502, "Das Dashboard hat den Zugang nicht gesperrt")
    audit(request, user, "pairing.revoke", target, platform=req.platform, user_id=req.user_id)
    return {"ok": True, **after}


async def _hooks(dash: Dash, agent: str) -> dict[str, Any]:
    b = await upstream(dash.request("GET", "/api/webhooks", params={"profile": agent}))
    subs = b.get("subscriptions") if isinstance(b, dict) else None
    if not isinstance(subs, list) or not isinstance(b.get("enabled"), bool):
        raise HTTPException(502, "Das Dashboard liefert die Webhooks in unbekannter Form")
    keep = ("name", "description", "events", "deliver", "deliver_only", "prompt", "skills", "created_at", "url", "secret_set", "enabled")
    return {"enabled": b["enabled"], "base_url": str(b.get("base_url", "")), "subscriptions": [{k: s.get(k) for k in keep} for s in subs if isinstance(s, dict)]}


@router.get("/hermes-webhooks")
async def hooks_read(target: Tgt, dash: Dash):
    return await _hooks(dash, target.agent.id)


class EnableIn(BaseModel):
    model_config = {"extra": "forbid"}
    confirm_restart: bool = False


@router.post("/hermes-webhooks/enable")
async def hooks_enable(request: Request, target: Tgt, dash: Dash, req: EnableIn, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-access")
    if not req.confirm_restart:
        raise HTTPException(422, "Einschalten startet das Gateway neu und unterbricht laufende Sitzungen: confirm_restart=true senden")
    await upstream(dash.request("POST", "/api/webhooks/enable", params={"profile": target.agent.id}))
    after = await _hooks(dash, target.agent.id)
    if not after["enabled"]:
        raise HTTPException(502, "Das Dashboard hat die Webhook-Plattform nicht eingeschaltet")
    audit(request, user, "webhooks.enable", target)
    return {"ok": True, **after}


class HookIn(BaseModel):
    model_config = {"extra": "forbid"}  # kein script, kein secret
    name: str = Field(min_length=1, max_length=64)
    description: str = Field(default="", max_length=300)
    events: list[str] = Field(default_factory=list, max_length=20)
    prompt: str = Field(default="", max_length=4000)
    skills: list[str] = Field(default_factory=list, max_length=20)
    deliver: str = Field(default="log", max_length=32)
    deliver_only: bool = False
    deliver_chat_id: str = Field(default="", max_length=128)

    @field_validator("name")
    @classmethod
    def _n(cls, v: str) -> str:
        v = v.strip().lower().replace(" ", "-")
        if not NAME.match(v):
            raise ValueError("Name: nur a-z, 0-9, - und _")
        return v

    @field_validator("deliver")
    @classmethod
    def _d(cls, v: str) -> str:
        if not PLATFORM.match(v):
            raise ValueError("Ziel: ungültige Zeichen")
        return v

    @field_validator("events", "skills")
    @classmethod
    def _items(cls, v: list[str]) -> list[str]:
        if any(not i.strip() or len(i) > 100 for i in v):
            raise ValueError("Einträge: nicht leer, höchstens 100 Zeichen")
        return [i.strip() for i in v]


@router.post("/hermes-webhooks")
async def hooks_create(request: Request, response: Response, target: Tgt, dash: Dash, req: HookIn, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-access")
    if req.deliver_only and req.deliver == "log":
        raise HTTPException(422, "Direkte Zustellung braucht ein echtes Ziel, nicht „log“")
    if not (await _hooks(dash, target.agent.id))["enabled"]:
        raise HTTPException(409, "Die Webhook-Plattform ist ausgeschaltet: erst einschalten (startet das Gateway neu)")
    body = {k: v for k, v in req.model_dump().items() if v not in ("", [])} | {"deliver_only": req.deliver_only}
    out = await upstream(dash.request("POST", "/api/webhooks", body=body, params={"profile": target.agent.id}))
    secret = out.get("secret") if isinstance(out, dict) else None
    after = await _hooks(dash, target.agent.id)
    if not isinstance(secret, str) or not any(s["name"] == req.name for s in after["subscriptions"]):
        raise HTTPException(502, "Das Dashboard hat den Webhook nicht angelegt")
    audit(request, user, "webhooks.create", target, name=req.name, events=len(req.events))
    response.headers["Cache-Control"] = "no-store"
    return {"ok": True, "name": req.name, "url": next(s["url"] for s in after["subscriptions"] if s["name"] == req.name), "secret": secret}


class ToggleIn(BaseModel):
    model_config = {"extra": "forbid"}
    enabled: bool


@router.put("/hermes-webhooks/{name}/enabled")
async def hooks_toggle(name: str, request: Request, target: Tgt, dash: Dash, req: ToggleIn, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-access")
    if not NAME.match(name):
        raise HTTPException(422, "Name: ungültige Zeichen")
    await upstream(dash.request("PUT", f"/api/webhooks/{name}/enabled", body={"enabled": req.enabled}, params={"profile": target.agent.id}, missing="Webhook nicht gefunden"))
    row = next((s for s in (await _hooks(dash, target.agent.id))["subscriptions"] if s["name"] == name), None)
    if row is None or row["enabled"] is not req.enabled:
        raise HTTPException(502, "Das Dashboard hat den Webhook nicht umgeschaltet")
    audit(request, user, "webhooks.toggle", target, name=name, enabled=req.enabled)
    return {"ok": True, "name": name, "enabled": req.enabled}


@router.delete("/hermes-webhooks/{name}")
async def hooks_delete(name: str, request: Request, target: Tgt, dash: Dash, confirm: str = Query(default=""), user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-access")
    if not NAME.match(name):
        raise HTTPException(422, "Name: ungültige Zeichen")
    if confirm != name:
        raise HTTPException(422, "Löschen: den Webhook-Namen zur Bestätigung eingeben")
    await upstream(dash.request("DELETE", f"/api/webhooks/{name}", params={"profile": target.agent.id}, missing="Webhook nicht gefunden"))
    if any(s["name"] == name for s in (await _hooks(dash, target.agent.id))["subscriptions"]):
        raise HTTPException(502, "Das Dashboard hat den Webhook nicht gelöscht")
    audit(request, user, "webhooks.delete", target, name=name)
    return {"ok": True}
