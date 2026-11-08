from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from ..auth import User, current_user, is_fresh
from ..oidc import OidcError, step_up_proof

router = APIRouter(prefix="/bff", dependencies=[Depends(current_user)])


@router.get("/me")
async def me(request: Request, user: User = Depends(current_user)):
    settings = request.app.state.settings
    return {
        "user": {"id": user.id, "name": user.name},
        "auth_mode": settings.auth_mode,
        "fresh": is_fresh(request),
        "build": settings.build or None,
    }


@router.get("/security")
async def security(request: Request, _user: User = Depends(current_user)):
    """Ob riskante Aktionen eine frische Anmeldung verlangen und ob der Anbieter sie belegen kann (siehe Seite System)."""
    s = request.app.state.settings
    if s.auth_mode == "none" or not s.step_up:
        return {"step_up": {"enabled": False, "window_s": s.step_up_s, "proof": "off"}}
    try:
        proof = step_up_proof(await request.app.state.oidc.metadata())
    except OidcError:
        proof = "unavailable"
    return {"step_up": {"enabled": True, "window_s": s.step_up_s, "proof": proof}}


@router.get("/hosts")
async def hosts(request: Request):
    """Alle Hosts mit Runtimes, Agents und Status. Der Status kommt aus kurzen, zwischengespeicherten Proben."""
    return await request.app.state.hosts.overview()
