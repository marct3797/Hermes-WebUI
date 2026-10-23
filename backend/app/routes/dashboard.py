"""Profil-Routen über das Dashboard: SOUL.md, Beschreibung, Modell. /bff/h/<host>/<runtime>/<agent>/…

Ohne `dashboard` in der Host-Config ist alles hier "nicht eingerichtet"; die Seite erklärt dann, was fehlt.
Schreibende Aufrufe landen im Audit-Log, nie mit dem Inhalt (nur Längen).
"""
from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from pydantic import BaseModel, Field

from ..adapters import UpstreamError
from ..auth import User, current_user, fresh_user
from ..dashboard import (
    DESCRIPTION_MAX_CHARS, SOUL_MAX_CHARS, VERSION_RE, DashboardClient, SoulConflict, SoulHistory, digest, save_soul,
)
from ..hosts import Target
from ..security import client_ip
from .agents import Tgt, audit as audit_target, upstream

router = APIRouter(prefix="/bff/h/{host}/{runtime}/{agent}", dependencies=[Depends(current_user)])

VersionId = Annotated[str, Path(pattern=VERSION_RE.pattern)]
NOT_CONFIGURED = "Für diese Runtime ist kein Dashboard eingerichtet"
PROFILE_FIELDS = ("name", "model", "provider", "description", "description_auto", "skill_count", "gateway_running", "has_env")


def dashboard_of(target: Tgt, request: Request) -> DashboardClient:
    cfg = target.runtime.dashboard
    if cfg is None:
        raise HTTPException(501, NOT_CONFIGURED)
    return DashboardClient(cfg, request.app.state.http)


Dash = Annotated[DashboardClient, Depends(dashboard_of)]


def history(request: Request) -> SoulHistory:
    return request.app.state.souls


Hist = Annotated[SoulHistory, Depends(history)]


def audit(request: Request, user: User, action: str, target: Target, **detail: Any) -> None:
    audit_target(request, user, action, target, **detail)


@router.get("/dashboard")
async def dashboard_status(target: Tgt, request: Request):
    """Ist ein Dashboard angebunden und erreichbar, und was weiß es über dieses Profil? Fehler sind hier Daten, keine Fehlercodes."""
    cfg = target.runtime.dashboard
    if cfg is None:
        return {"available": False, "reason": NOT_CONFIGURED, "profile": None}
    try:
        found = await DashboardClient(cfg, request.app.state.http).profile(target.agent.id)
    except UpstreamError as e:
        return {"available": False, "reason": e.detail, "profile": None}
    profile = {k: found.get(k) for k in PROFILE_FIELDS} if found else None
    return {"available": True, "reason": None if profile else "Das Dashboard kennt dieses Profil nicht", "profile": profile}


@router.get("/soul")
async def read_soul(target: Tgt, dash: Dash, hist: Hist):
    soul = await upstream(dash.soul(target.agent.id))
    return {**soul, "hash": digest(soul["content"]), "max_chars": SOUL_MAX_CHARS,
            "history": hist.entries(target.host.id, target.runtime.id, target.agent.id)}


class SoulIn(BaseModel):
    content: str = Field(max_length=SOUL_MAX_CHARS)
    base: str | None = Field(None, max_length=32)  # Fingerabdruck des geladenen Stands; abweichend = 409


class RestoreIn(BaseModel):
    id: str = Field(pattern=VERSION_RE.pattern)


async def _save(request: Request, user: User, target: Target, dash: DashboardClient, hist: SoulHistory,
                content: str, base: str | None, reason: str) -> dict[str, Any]:
    request.app.state.limiter.check(f"{user.id}:dashboard")
    try:
        result = await upstream(save_soul(dash, hist, target.host.id, target.runtime.id, target.agent.id, content, base=base, reason=reason))
    except SoulConflict as e:
        raise HTTPException(409, {"code": "soul_changed", "message": "SOUL.md wurde inzwischen geändert", "current": e.current,
                                  "hash": digest(e.current)}) from e
    return {**result, "history": hist.entries(target.host.id, target.runtime.id, target.agent.id)}


@router.put("/soul")
async def write_soul(request: Request, target: Tgt, dash: Dash, hist: Hist, req: SoulIn, user: User = Depends(current_user)):
    """SOUL.md bestimmt das Verhalten des Agents dauerhaft: verlangt eine frische Anmeldung (Step-up)."""
    user = await fresh_user(request, user)
    result = await _save(request, user, target, dash, hist, req.content, req.base, "vor Änderung")
    audit(request, user, "soul.update", target, chars=len(req.content), changed=result["changed"])
    return result


@router.get("/soul/history/{version}")
async def read_version(target: Tgt, hist: Hist, version: VersionId):
    entry = hist.get(target.host.id, target.runtime.id, target.agent.id, version)
    if entry is None:
        raise HTTPException(404, "Dieser Stand existiert nicht")
    return entry


@router.post("/soul/restore")
async def restore_soul(request: Request, target: Tgt, dash: Dash, hist: Hist, req: RestoreIn, user: User = Depends(current_user)):
    """Holt einen früheren Stand zurück. Der aktuelle wird zuvor im Verlauf gesichert, nichts geht verloren."""
    user = await fresh_user(request, user)
    entry = hist.get(target.host.id, target.runtime.id, target.agent.id, req.id)
    if entry is None:
        raise HTTPException(404, "Dieser Stand existiert nicht")
    result = await _save(request, user, target, dash, hist, entry["content"], None, "vor Wiederherstellung")
    audit(request, user, "soul.restore", target, version=req.id, changed=result["changed"])
    return {**result, "content": entry["content"], "hash": digest(entry["content"])}


class DescriptionIn(BaseModel):
    description: str = Field(max_length=DESCRIPTION_MAX_CHARS)


@router.put("/profile/description")
async def write_description(request: Request, target: Tgt, dash: Dash, req: DescriptionIn, user: User = Depends(current_user)):
    request.app.state.limiter.check(f"{user.id}:dashboard")
    text = req.description.strip()
    await upstream(dash.set_description(target.agent.id, text))
    audit(request, user, "profile.description", target, chars=len(text))
    return {"ok": True, "description": text}


class ModelIn(BaseModel):
    provider: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:/-]*$")
    model: str = Field(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:/@+-]*$")


@router.put("/profile/model")
async def write_model(request: Request, target: Tgt, dash: Dash, req: ModelIn, user: User = Depends(current_user)):
    """Standardmodell dieses Profils (gilt für neue Sessions). Laufende Runs behalten ihr Modell."""
    request.app.state.limiter.check(f"{user.id}:dashboard")
    await upstream(dash.set_model(target.agent.id, req.provider, req.model))
    audit(request, user, "profile.model", target, provider=req.provider, model=req.model)
    return {"ok": True, "provider": req.provider, "model": req.model}
