"""Schlüssel-Pools (Punkt 8). Schranken siehe tests/test_hermes_credentials.py.

Nicht durchgereicht: OAuth-Einträge (brauchen einen Browser-Ablauf der CLI) und das Entfernen von Einträgen, die aus .env/OAuth stammen
(Hermes räumt deren Ursprung auf: .env-Zeile, Token-Datei).
"""
from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator

from ..auth import User, current_user, fresh_user
from .agents import Tgt, upstream
from .dashboard import Dash, audit

router = APIRouter(prefix="/bff/h/{host}/{runtime}/{agent}", dependencies=[Depends(current_user)])

PROVIDER = re.compile(r"^[a-z0-9][a-z0-9_.:-]{0,63}$")


def _limit(request: Request, user: User, what: str) -> None:
    request.app.state.limiter.check(f"{user.id}:{what}")


def _tail(preview: Any) -> str:
    return preview[-4:] if isinstance(preview, str) else ""  # höchstens vier Zeichen, auch wenn Hermes mehr zeigt


async def _pool(dash: Dash, agent: str) -> list[dict[str, Any]]:
    b = await upstream(dash.request("GET", "/api/credentials/pool", params={"profile": agent}))
    provs = b.get("providers") if isinstance(b, dict) else None
    if not isinstance(provs, list):
        raise HTTPException(502, "Das Dashboard liefert die Schlüssel-Pools in unbekannter Form")
    out = []
    for p in provs:
        if not isinstance(p, dict) or not isinstance(p.get("entries"), list):
            continue
        out.append({"provider": str(p.get("provider", ""))[:64], "entries": [
            {"index": e.get("index"), "label": str(e.get("label", ""))[:60], "auth_type": str(e.get("auth_type", ""))[:20], "source": str(e.get("source", ""))[:80],
             "last_status": e.get("last_status") if isinstance(e.get("last_status"), str) else None, "request_count": e.get("request_count") if isinstance(e.get("request_count"), int) else 0,
             "token_tail": _tail(e.get("token_preview")), "has_refresh": bool(e.get("has_refresh"))} for e in p["entries"] if isinstance(e, dict)]})
    return out


def _count(pool: list[dict[str, Any]], provider: str) -> int:
    return next((len(p["entries"]) for p in pool if p["provider"] == provider), 0)


@router.get("/hermes-credentials")
async def pool_read(target: Tgt, dash: Dash):
    return {"providers": await _pool(dash, target.agent.id)}


class AddIn(BaseModel):
    model_config = {"extra": "forbid"}
    provider: str
    api_key: str = Field(min_length=8, max_length=5000)
    label: str = Field(default="", max_length=60)

    @field_validator("provider")
    @classmethod
    def _p(cls, v: str) -> str:
        v = v.strip().lower()
        if not PROVIDER.match(v):
            raise ValueError("Anbieter: nur a-z, 0-9 und . _ : -")
        return v


@router.post("/hermes-credentials")
async def pool_add(request: Request, target: Tgt, dash: Dash, req: AddIn, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-credentials")
    before = _count(await _pool(dash, target.agent.id), req.provider)
    await upstream(dash.request("POST", "/api/credentials/pool", body={"provider": req.provider, "api_key": req.api_key.strip(), "label": req.label or None}, params={"profile": target.agent.id}))
    count = _count(await _pool(dash, target.agent.id), req.provider)
    if count != before + 1:
        raise HTTPException(502, "Das Dashboard hat den Schlüssel nicht in den Pool aufgenommen")
    audit(request, user, "credentials.add", target, provider=req.provider)
    return {"ok": True, "provider": req.provider, "count": count}


@router.delete("/hermes-credentials/{provider}/{index}")
async def pool_remove(provider: str, index: int, request: Request, target: Tgt, dash: Dash, confirm: str = Query(default=""), user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-credentials")
    if not PROVIDER.match(provider) or index < 1:
        raise HTTPException(422, "Anbieter oder Nummer ungültig")
    if confirm != provider:
        raise HTTPException(422, "Entfernen: den Anbieternamen zur Bestätigung eingeben")
    pool = await _pool(dash, target.agent.id)
    entries = next((p["entries"] for p in pool if p["provider"] == provider), [])
    row = next((e for e in entries if e["index"] == index), None)
    if row is None:
        raise HTTPException(404, "Diesen Eintrag gibt es nicht")
    if row["source"] != "manual":
        raise HTTPException(422, "Dieser Eintrag stammt aus .env oder einer Anmeldung: Entfernen nur über die Hermes-CLI (sie räumt den Ursprung auf)")
    await upstream(dash.request("DELETE", f"/api/credentials/pool/{provider}/{index}", params={"profile": target.agent.id}))
    count = _count(await _pool(dash, target.agent.id), provider)
    if count != len(entries) - 1:
        raise HTTPException(502, "Das Dashboard hat den Eintrag nicht entfernt")
    audit(request, user, "credentials.remove", target, provider=provider, index=index)
    return {"ok": True, "provider": provider, "count": count}
