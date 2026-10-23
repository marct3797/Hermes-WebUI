"""Anmeldestatus der Coding-CLIs je Host (Statusbefehle laufen im Host-Dienst, nie hier)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request

from ..auth import User, current_user
from .operations import HostId, daemon, host_cfg

router = APIRouter(prefix="/bff")


async def fetch(request: Request, host: str, user: User, refresh: bool):
    host_cfg(request, host)
    try:
        result = await daemon(request, host).request("GET", "/v1/auth", params={"refresh": 1} if refresh else None)
    except HTTPException as exc:
        return {"available": False, "reason": "Host-Dienst nicht eingerichtet" if exc.status_code == 503 else exc.detail}
    clis = result.get("clis") if isinstance(result.get("clis"), list) else []
    if refresh:
        for cli in clis:
            request.app.state.audit.record("cli.auth.check", user=user.id, target=host, cli=str(cli.get("id"))[:64])
    return {"available": True, "reason": None, "clis": clis}


@router.get("/h/{host}/_cli-auth")
async def cli_auth(request: Request, host: HostId, user: User = Depends(current_user)):
    return await fetch(request, host, user, False)


@router.post("/h/{host}/_cli-auth/refresh")
async def cli_auth_refresh(request: Request, host: HostId, user: User = Depends(current_user)):
    return await fetch(request, host, user, True)
