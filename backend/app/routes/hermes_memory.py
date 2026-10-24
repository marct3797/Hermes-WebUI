"""Eingebautes Hermes-Gedächtnis (MEMORY.md/USER.md) und externe Gedächtnis-Anbieter eines Profils.

Das Dashboard liefert vom eingebauten Gedächtnis nur die Dateigrößen, nie den Inhalt. Anbieter und ihre Felder kommen vom Dashboard; Geheimnisse
werden nur geschrieben. Der Anbieter-Setup von Hermes (`POST .../setup`) führt Installationsbefehle mit Shell aus (`curl ... | sh`) und fehlt hier
absichtlich: die fehlenden Programme werden nur genannt. Zurücksetzen löscht ohne Papierkorb und verlangt, den Zielnamen einzutippen.
"""
from __future__ import annotations

import math
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from pydantic import BaseModel, Field

from ..auth import User, current_user, fresh_user
from ..dashboard_ops import clip
from .agents import Tgt, upstream
from .dashboard import Dash, audit
from .tools import _check_value, pick, scope

router = APIRouter(prefix="/bff/h/{host}/{runtime}/{agent}", dependencies=[Depends(current_user)])

Provider = Annotated[str, Path(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")]
FIELD_FIELDS = ("key", "label", "kind", "description", "placeholder", "required", "is_set", "options", "url")


class ProviderIn(BaseModel):
    provider: str = Field(max_length=64, pattern=r"^([A-Za-z0-9][A-Za-z0-9_-]*)?$")


class ResetIn(BaseModel):
    target: Literal["all", "memory", "user"]
    confirm: str = ""


class ConfigIn(BaseModel):
    values: dict[str, Any] = Field(min_length=1, max_length=40)


def _limit(request: Request, user: User) -> None:
    request.app.state.limiter.check(f"{user.id}:hermes-memory")


async def _overview(target: Tgt, dash: Dash) -> dict[str, Any]:
    body = await upstream(dash.request("GET", "/api/memory", params=scope(target)))
    if not isinstance(body, dict) or not isinstance(body.get("providers"), list) or not isinstance(body.get("builtin_files"), dict):
        raise HTTPException(502, "Das Dashboard liefert das Gedächtnis in einer unbekannten Form")
    providers = []
    for p in body["providers"]:
        if not isinstance(p, dict) or not isinstance(p.get("name"), str):
            continue
        setup: dict[str, Any] = p["setup"] if isinstance(p.get("setup"), dict) else {}
        deps = [d for d in setup.get("external_dependencies", []) if isinstance(d, dict)] if not setup.get("dependencies_installed", True) else []
        providers.append({"name": p["name"], "description": clip(p.get("description"), 200), "status": p.get("status"), "configured": bool(p.get("configured")), "available": bool(p.get("available")),
                          "required_env": [e for e in setup.get("required_env", []) if isinstance(e, str)],
                          "missing": [{"name": clip(d.get("name"), 60), "install": str(d.get("install") or "")[:200]} for d in deps]})
    files = {k: int(body["builtin_files"].get(k) or 0) for k in ("memory", "user")}
    return {"active": body.get("active") or "", "providers": providers, "files": files}


@router.get("/hermes-memory")
async def overview(target: Tgt, dash: Dash):
    return await _overview(target, dash)


@router.put("/hermes-memory/provider")
async def set_provider(request: Request, target: Tgt, dash: Dash, req: ProviderIn, user: User = Depends(fresh_user)):
    _limit(request, user)
    now = await _overview(target, dash)
    if req.provider:
        row = next((p for p in now["providers"] if p["name"] == req.provider), None)
        if row is None or row["status"] != "ready":
            raise HTTPException(422, "Dieser Anbieter ist unbekannt oder noch nicht bereit")
    await upstream(dash.request("PUT", "/api/memory/provider", body={"provider": req.provider}, params=scope(target)))
    if (await _overview(target, dash))["active"] != req.provider:
        raise HTTPException(502, "Das Dashboard hat die Änderung nicht übernommen")
    audit(request, user, "hermes_memory.provider", target, provider=req.provider or "built-in")
    return {"ok": True, "active": req.provider}


@router.post("/hermes-memory/reset")
async def reset(request: Request, target: Tgt, dash: Dash, req: ResetIn, user: User = Depends(fresh_user)):
    _limit(request, user)
    if req.confirm != req.target:
        raise HTTPException(422, f"Zum Bestätigen „{req.target}“ eintippen. Das Löschen ist endgültig.")
    body = await upstream(dash.request("POST", "/api/memory/reset", body={"target": req.target}, params=scope(target)))
    left = (await _overview(target, dash))["files"]
    if any(left[k] for k in ("memory", "user") if req.target in ("all", k)):
        raise HTTPException(502, "Das Dashboard hat die Änderung nicht übernommen")
    deleted = [x for x in (body.get("deleted") if isinstance(body, dict) else []) or [] if x in ("MEMORY.md", "USER.md")]
    audit(request, user, "hermes_memory.reset", target, scope=req.target, deleted=deleted)
    return {"ok": True, "deleted": deleted}


async def _fields(target: Tgt, dash: Dash, name: str) -> list[dict[str, Any]]:
    body = await upstream(dash.request("GET", f"/api/memory/providers/{name}/config", params=scope(target), missing="Unbekannter Gedächtnis-Anbieter"))
    if not isinstance(body, dict) or not isinstance(body.get("fields"), list):
        raise HTTPException(502, "Das Dashboard liefert die Felder in einer unbekannten Form")
    out = []
    for f in body["fields"]:
        if not isinstance(f, dict) or not isinstance(f.get("key"), str):
            continue
        row = pick(f, FIELD_FIELDS)
        row["is_set"] = bool(row.get("is_set"))
        row["options"] = [pick(o, ("value", "label")) for o in f.get("options", []) if isinstance(o, dict)]
        if f.get("kind") != "secret":
            row["value"] = clip(f.get("value"), 500) if isinstance(f.get("value"), str) else ""
        out.append(row)
    return out


@router.get("/hermes-memory/providers/{name}")
async def provider_config(name: Provider, target: Tgt, dash: Dash):
    return {"name": name, "fields": await _fields(target, dash, name)}


def _value(field: dict[str, Any], value: Any) -> Any:
    key, kind = field["key"], field.get("kind")
    if kind in ("secret", "text"):
        if not isinstance(value, str):
            raise HTTPException(422, f"{key}: Text erwartet")
        return _check_value(key, value)
    if kind == "select":
        if not isinstance(value, str) or value not in {o["value"] for o in field["options"]}:
            raise HTTPException(422, f"{key}: kein erlaubter Wert")
        return value
    if kind == "boolean" and isinstance(value, bool):
        return value
    if kind in ("integer", "number") and isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and (kind == "number" or isinstance(value, int)):
        return value
    raise HTTPException(422, f"{key}: ungültiger Wert")


@router.put("/hermes-memory/providers/{name}")
async def save_provider(request: Request, name: Provider, target: Tgt, dash: Dash, req: ConfigIn, user: User = Depends(fresh_user)):
    _limit(request, user)
    fields = {f["key"]: f for f in await _fields(target, dash, name)}
    values: dict[str, Any] = {}
    for key, raw in req.values.items():
        if key not in fields:
            raise HTTPException(422, f"{key}: kein Feld dieses Anbieters")
        v = _value(fields[key], raw)
        if not (fields[key].get("kind") == "secret" and v == ""):  # leerer Schlüssel löscht nichts
            values[key] = v
    result = await upstream(dash.request("PUT", f"/api/memory/providers/{name}/config", body={"values": values}, params=scope(target)))
    after = {f["key"]: f for f in await _fields(target, dash, name)}
    wrong = sorted(k for k in values if fields[k].get("kind") == "secret" and not after.get(k, {}).get("is_set"))
    if wrong:
        raise HTTPException(502, "Das Dashboard hat nicht übernommen: " + ", ".join(wrong))
    audit(request, user, "hermes_memory.config", target, provider=name, keys=sorted(values))
    return {"ok": True, "active": result.get("active") if isinstance(result, dict) else None}
