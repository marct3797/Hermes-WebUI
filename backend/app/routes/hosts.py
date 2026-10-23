from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from ..auth import User, current_user, is_fresh

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


@router.get("/hosts")
async def hosts(request: Request):
    """Alle Hosts mit Runtimes, Agents und Status. Der Status kommt aus kurzen, zwischengespeicherten Proben."""
    return await request.app.state.hosts.overview()
