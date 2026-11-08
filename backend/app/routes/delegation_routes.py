"""Delegation: Modellrouten und Profilrouten schreiben (Etappe 3 der Abdeckung).

Hermes ersetzt je Aufruf den ganzen Block `delegation.backends.model_map` bzw. `profile_routes`. Eine Route kann einen Schlüssel tragen.
Darum gilt hier:
- Der Browser sieht nie einen Schlüssel. Beim Lesen steht nur `has_api_key` (siehe `endpoints.py`). Ein neuer Schlüssel ist write-only.
- Beim Schreiben baut das BFF jede Route aus dem gespeicherten Stand auf (Hermes liefert eine Vorschau mit; Hermes behält damit den
  echten Schlüssel) und überlagert nur die Felder, die die Maske kennt. Alles andere (`request_overrides`, `fallback_providers`, Felder
  eines Backends) bleibt, wie es war, und geht nicht beim Speichern verloren.
- Frische Anmeldung, Rate-Limit, Namenseingabe (Agent-ID) für das Ersetzen, Rücklesen, Audit ohne Inhalt.
"""
from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from ..auth import User, current_user, fresh_user
from .agents import Tgt, upstream
from .dashboard import Dash, audit
from .endpoints import _limit, _routing, _safe_url

router = APIRouter(prefix="/bff/h/{host}/{runtime}/{agent}", dependencies=[Depends(current_user)])

NAME = r"^[^\x00-\x1f]{1,100}$"
TEXT_KEYS = ("description", "provider", "model", "base_url")
Effort = Annotated[str, Field(default="", max_length=30, pattern=r"^[A-Za-z0-9_-]*$")]  # Hermes prüft die Werte selbst (VALID_REASONING_EFFORTS, STATIC_TIERS)
Tier = Annotated[str, Field(default="", max_length=30, pattern=r"^[A-Za-z0-9_-]*$")]


class Route(BaseModel):
    model_config = {"extra": "forbid"}
    name: str = Field(min_length=1, max_length=100, pattern=NAME)
    original_name: str = Field(default="", max_length=100)  # unter diesem Namen steht die Route heute (Umbenennen)
    description: str = Field(default="", max_length=1000)
    provider: str = Field(default="", max_length=100)
    model: str = Field(default="", max_length=200)
    base_url: str = Field(default="", max_length=500)
    reasoning_effort: Effort
    service_tier: Tier
    api_key: str = Field(default="", max_length=5000)  # write-only; leer = vorhandenen behalten
    clear_api_key: bool = False

    @field_validator("base_url")
    @classmethod
    def _url(cls, v: str) -> str:
        return _safe_url(v) if v.strip() else ""


class ModelMapIn(BaseModel):
    model_config = {"extra": "forbid"}
    options: list[Route] = Field(max_length=50)
    default: str = Field(default="", max_length=100)
    confirm: str = Field(max_length=100)


class ProfileRoute(BaseModel):
    model_config = {"extra": "forbid"}
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=1000)


class ProfileRoutesIn(BaseModel):
    model_config = {"extra": "forbid"}
    profiles: list[ProfileRoute] = Field(max_length=50)
    default: str = Field(default="", max_length=100)
    confirm: str = Field(max_length=100)


def _need(typed: str, word: str) -> None:
    if typed.strip() != word:
        raise HTTPException(422, f"Zum Bestätigen „{word}“ eintippen.")


def _stored(block: Any) -> dict[str, dict[str, Any]]:
    rows = block.get("options") if isinstance(block, dict) else None
    return {str(o.get("name")): o for o in rows or [] if isinstance(o, dict) and o.get("name")}


def build_option(route: Route, stored: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Eine Route für Hermes: gespeicherter Stand (inkl. Schlüsselvorschau und fremder Felder) + die Felder der Maske."""
    base = dict(stored.get(route.original_name or route.name) or stored.get(route.name) or {})
    known = bool(base)
    out = {k: v for k, v in base.items() if k not in (*TEXT_KEYS, "reasoning_effort", "service_tier", "name", "original_name")}
    for key in TEXT_KEYS:
        value = getattr(route, key).strip()
        if value:
            out[key] = value
    for key in ("reasoning_effort", "service_tier"):
        if getattr(route, key):
            out[key] = getattr(route, key)
    out["name"] = route.name.strip()
    if known:
        out["original_name"] = route.original_name or route.name
    if route.api_key.strip():
        out["api_key"] = route.api_key.strip()
    elif route.clear_api_key:
        out.pop("api_key", None)
    elif out.get("api_key") and any(str(base.get(k) or "") != str(out.get(k) or "") for k in ("base_url", "provider")):
        # Ein gespeicherter Schlüssel darf nicht an ein anderes Ziel mitwandern, ohne dass jemand ihn neu eingibt.
        raise HTTPException(422, f"Route „{route.name.strip()}“: Adresse oder Anbieter geändert. Schlüssel neu eingeben oder entfernen.")
    return out


def _view(options: Any) -> list[dict[str, Any]]:
    keep = ("name", "description", "provider", "model", "base_url", "reasoning_effort", "service_tier")
    return [{**{k: o.get(k, "") for k in keep}, "has_api_key": bool(o.get("api_key"))} for o in options or [] if isinstance(o, dict)]


@router.put("/hermes-delegation/model-map")
async def save_model_map(request: Request, target: Tgt, dash: Dash, req: ModelMapIn, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-endpoints")
    _need(req.confirm, target.agent.id)
    names = [o.name.strip() for o in req.options]
    if len(set(names)) != len(names):
        raise HTTPException(422, "Routen-Namen müssen eindeutig sein.")
    if req.default.strip() and req.default.strip() not in names:
        raise HTTPException(422, "Die Standardroute muss in der Liste stehen.")
    before = (await _routing(dash, target.agent.id)).get("model_map") or {}
    stored = _stored(before)
    options = [build_option(o, stored) for o in req.options]
    body = {"options": options, "default": req.default.strip()}
    await upstream(dash.request("PUT", "/api/delegation/backends/model_map", body=body, params={"profile": target.agent.id}))
    after = (await _routing(dash, target.agent.id)).get("model_map") or {}
    now = _stored(after)
    kept = all(bool(now.get(o["name"], {}).get("api_key")) == bool(o.get("api_key")) for o in options)  # ein Hermes ohne Vorschau-Erkennung würde den echten Schlüssel überschreiben
    ok = [o.get("name") for o in after.get("options") or [] if isinstance(o, dict)] == names and (after.get("default") or "") == req.default.strip() and kept
    audit(request, user, "delegation.model_map", target, routes=len(names), new_keys=sum(bool(o.api_key.strip()) for o in req.options), default=bool(req.default.strip()), verified=ok)
    if not ok:
        raise HTTPException(502, "Das Dashboard hat die Modellrouten nicht übernommen")
    return {"ok": True, "options": _view(after.get("options")), "default": after.get("default") or None}


@router.put("/hermes-delegation/profile-routes")
async def save_profile_routes(request: Request, target: Tgt, dash: Dash, req: ProfileRoutesIn, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-endpoints")
    _need(req.confirm, target.agent.id)
    names = [p.name.strip() for p in req.profiles]
    known = (await _routing(dash, target.agent.id)).get("profiles") or []
    if any(n not in known for n in names):
        raise HTTPException(422, "Ein Profil in der Liste gibt es nicht.")
    if len(set(names)) != len(names):
        raise HTTPException(422, "Ein Profil steht doppelt in der Liste.")
    if req.default.strip() and req.default.strip() not in names:
        raise HTTPException(422, "Das Standardprofil muss in der Liste stehen.")
    body = {"profiles": [{"name": p.name.strip(), "description": p.description.strip()} for p in req.profiles], "default": req.default.strip()}
    await upstream(dash.request("PUT", "/api/delegation/backends/profile_routes", body=body, params={"profile": target.agent.id}))
    after = (await _routing(dash, target.agent.id)).get("profile_routes") or {}
    rows = [p for p in after.get("profiles") or [] if isinstance(p, dict)]
    ok = [p.get("name") for p in rows] == names and (after.get("default") or "") == req.default.strip()
    audit(request, user, "delegation.profile_routes", target, profiles=len(names), default=bool(req.default.strip()), verified=ok)
    if not ok:
        raise HTTPException(502, "Das Dashboard hat die Profilrouten nicht übernommen")
    return {"ok": True, "profiles": [{"name": p.get("name"), "description": p.get("description", "")} for p in rows], "default": after.get("default") or None}
