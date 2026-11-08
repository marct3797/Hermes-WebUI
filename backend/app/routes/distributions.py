"""Profil-Distributionen installieren und aktualisieren, über den Host-Dienst (`hermes profile install|update` gibt es in Hermes nur als CLI).

Eine Distribution bringt SOUL, `mcp.json`, Skills, Zeitpläne und Konfiguration mit: fremder Code mit den Rechten des Agents. Darum:
- Nur Quellen, die der Betreiber in hostd freigegeben hat (`distribution_sources`). Der Browser nennt eine Quellen-ID, nie eine Adresse.
- Erst Vorschau (Manifest, Dateiliste, Prüfsumme), dann Installieren/Aktualisieren nur mit genau dieser Prüfsumme (hostd prüft sie gegen den Klon, der kopiert wird).
- Frische Anmeldung, eingetippter Profilname, Rate-Limit, Audit (Quelle, Name, Version; ohne Inhalt), 502 wenn Hermes das Ergebnis nicht bestätigt.
"""
from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from ..auth import User, current_user, fresh_user
from .agents import Tgt
from .dashboard import audit
from .vault_secrets import _call

router = APIRouter(prefix="/bff/h/{host}/{runtime}/{agent}", dependencies=[Depends(current_user)])

WAIT = 170.0  # Klonen und Kopieren; größer als die Grenze in hostd (150 s)
NAME = r"^[a-z0-9][a-z0-9_-]{0,63}$"
SOURCE_ID = r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
PREVIEW_KEYS = ("name", "version", "description", "author", "license", "hermes_requires", "env_requires", "files", "file_count", "has_mcp", "has_cron", "existing", "existing_is_distribution", "existing_source", "preserves_config", "risky_config", "extra_top_level", "source", "digest")


def _preview(body: dict[str, Any]) -> dict[str, Any]:
    p = body.get("preview")
    if not isinstance(p, dict) or not isinstance(p.get("digest"), str):
        raise HTTPException(502, "Der Host-Dienst liefert die Vorschau in einer unbekannten Form")
    return {k: p.get(k) for k in PREVIEW_KEYS if k in p}


@router.get("/distributions")
async def sources(request: Request, target: Tgt) -> dict[str, Any]:
    body = await _call(request, target, "GET", "distributions", wait=WAIT)
    rows = body.get("sources")
    if not isinstance(rows, list):
        raise HTTPException(502, "Der Host-Dienst liefert die Quellen in einer unbekannten Form")
    return {"sources": [{"id": r["id"], "label": r.get("label") or r["id"], "source": r.get("source", "")} for r in rows if isinstance(r, dict) and isinstance(r.get("id"), str)]}


class PreviewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_id: str = Field(pattern=SOURCE_ID)
    name: str | None = Field(default=None, pattern=NAME)       # Installieren unter diesem Namen
    profile: str | None = Field(default=None, pattern=NAME)    # oder: Update dieses Profils


@router.post("/distributions/preview")
async def preview(request: Request, target: Tgt, req: PreviewIn, user: User = Depends(current_user)) -> dict[str, Any]:
    request.app.state.limiter.check(f"{user.id}:distributions")
    if bool(req.name) == bool(req.profile):
        raise HTTPException(422, "Entweder einen Namen zum Installieren oder ein Profil zum Aktualisieren angeben.")
    body = await _call(request, target, "POST", "distributions/preview", req.model_dump(exclude_none=True), wait=WAIT)
    return {"preview": _preview(body)}


class ChangeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_id: str = Field(pattern=SOURCE_ID)
    name: str | None = Field(default=None, pattern=NAME)
    profile: str | None = Field(default=None, pattern=NAME)
    digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    force: bool = False
    force_config: bool = False
    confirm: str = Field(max_length=100)


async def _change(request: Request, target, user: User, action: str, req: ChangeIn) -> dict[str, Any]:
    request.app.state.limiter.check(f"{user.id}:distributions")
    subject = req.name if action == "install" else req.profile
    if not subject or (action == "install") == bool(req.profile):
        raise HTTPException(422, "Namen zum Installieren oder Profil zum Aktualisieren angeben.")
    if req.confirm.strip() != subject:
        raise HTTPException(422, f"Zum Bestätigen „{subject}“ eintippen.")
    ok = False
    try:
        body = await _call(request, target, "POST", f"distributions/{action}", req.model_dump(exclude={"confirm"}, exclude_none=True), wait=WAIT)
        done = body.get("done") if isinstance(body.get("done"), dict) else {}
        ok = done.get("name") == subject and done.get("digest") == req.digest and isinstance(done.get("version"), str)
    except HTTPException as exc:
        audit(request, user, f"distribution.{action}", target, source=req.source_id, name=subject, verified=False, status=exc.status_code)
        raise
    audit(request, user, f"distribution.{action}", target, source=req.source_id, name=subject, version=done.get("version") if ok else None, force=req.force, digest=req.digest[:12], verified=ok)
    if not ok:
        raise HTTPException(502, "Hermes hat die Distribution nicht bestätigt")
    return {"ok": True, "name": subject, "version": done["version"]}


@router.post("/distributions/install")
async def install(request: Request, target: Tgt, req: ChangeIn, user: User = Depends(fresh_user)) -> dict[str, Any]:
    return await _change(request, target, user, "install", req)


@router.post("/distributions/update")
async def update(request: Request, target: Tgt, req: ChangeIn, user: User = Depends(fresh_user)) -> dict[str, Any]:
    return await _change(request, target, user, "update", req)
