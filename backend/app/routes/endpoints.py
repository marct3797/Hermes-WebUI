"""Delegation, eigene Endpunkte, lokale Modelle (Punkt 8b). Schranken siehe tests/test_hermes_endpoints.py.

Nicht durchgereicht (bleibt CLI/Dashboard): Delegations-`model_map`/`profile_routes` schreiben (tragen Schlüssel je Route),
lokale Modelle installieren/laden/löschen/Server starten (laden Fremdcode und Gigabytes).
"""
from __future__ import annotations

import ipaddress
from typing import Any, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator

from ..auth import User, current_user, fresh_user
from .agents import Tgt, upstream
from .dashboard import Dash, audit

router = APIRouter(prefix="/bff/h/{host}/{runtime}/{agent}", dependencies=[Depends(current_user)])

BLOCKED_HOSTS = {"metadata.google.internal", "metadata"}


def _limit(request: Request, user: User, what: str) -> None:
    request.app.state.limiter.check(f"{user.id}:{what}")


def _safe_url(raw: str) -> str:
    # shortcut: prüft nur Schema/Zugangsdaten/Link-Local-IP, löst keine DNS-Namen auf; bei Mehrnutzer-Betrieb Egress-Filter ergänzen.
    u = urlsplit(raw.strip())
    host = (u.hostname or "").lower()
    if u.scheme not in ("http", "https") or not host or u.username or u.password:
        raise ValueError("URL: nur http(s) ohne Zugangsdaten in der Adresse")
    try:
        if ipaddress.ip_address(host).is_link_local:
            raise ValueError("URL: Link-Local-Adressen (Cloud-Metadaten) sind gesperrt")
    except ValueError as e:
        if "Link-Local" in str(e):
            raise
    if host in BLOCKED_HOSTS:
        raise ValueError("URL: Metadaten-Dienste sind gesperrt")
    return raw.strip().rstrip("/")


def _scrub(options: Any) -> list[dict[str, Any]]:
    # Hermes liefert nur eine Vorschau; trotzdem nie ein Schlüsselfeld weitergeben.
    return [{**{k: v for k, v in o.items() if k != "api_key"}, "has_api_key": bool(o.get("api_key"))} for o in options if isinstance(o, dict)] if isinstance(options, list) else []


async def _routing(dash: Dash, agent: str) -> dict[str, Any]:
    body = await upstream(dash.request("GET", "/api/delegation/routing", params={"profile": agent}))
    backends = body.get("backends") if isinstance(body, dict) else None
    if not isinstance(backends, list) or not body.get("configured") or not isinstance(body.get("profiles"), list):
        raise HTTPException(502, "Das Dashboard liefert die Delegation in unbekannter Form")
    return body


@router.get("/hermes-delegation")
async def delegation_read(target: Tgt, dash: Dash):
    b = await _routing(dash, target.agent.id)
    mm, pr = b.get("model_map") or {}, b.get("profile_routes") or {}
    return {"configured": b["configured"], "blocked_reason": b.get("blocked_reason"),
            "backends": [{"name": x.get("name"), "description": x.get("description", ""), "builtin": bool(x.get("builtin"))} for x in b["backends"] if isinstance(x, dict)],
            "model_map": {"options": _scrub(mm.get("options")), "default": mm.get("default")},
            "profile_routes": {"profiles": _scrub(pr.get("profiles")), "default": pr.get("default")}, "profiles": b["profiles"]}


class BackendIn(BaseModel):
    model_config = {"extra": "forbid"}
    backend: str = Field(min_length=1, max_length=100)


@router.put("/hermes-delegation/backend")
async def delegation_backend(request: Request, target: Tgt, dash: Dash, req: BackendIn, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-endpoints")
    name = req.backend.strip().lower()
    if name not in {x.get("name") for x in (await _routing(dash, target.agent.id))["backends"] if isinstance(x, dict)}:
        raise HTTPException(422, "Backend: dieses Backend meldet das Dashboard nicht")
    await upstream(dash.request("PUT", "/api/delegation/backend", body={"backend": name}, params={"profile": target.agent.id}))
    if (await _routing(dash, target.agent.id))["configured"] != name:
        raise HTTPException(502, "Das Dashboard hat das Delegations-Backend nicht übernommen")
    audit(request, user, "delegation.backend", target, backend=name)
    return {"ok": True, "backend": name}


class EndpointIn(BaseModel):
    model_config = {"extra": "forbid"}
    id: str = Field(default="", max_length=100)
    name: str = Field(min_length=1, max_length=100)
    base_url: str = Field(max_length=500)
    model: str = Field(min_length=1, max_length=200)
    api_key: str = Field(default="", max_length=5000)
    api_mode: Literal["", "chat_completions", "codex_responses", "anthropic_messages"] | None = None
    context_length: int | None = Field(default=None, ge=1, le=10_000_000)
    make_default: bool = False

    @field_validator("base_url")
    @classmethod
    def _url(cls, v: str) -> str:
        return _safe_url(v)


def _listing(body: Any) -> dict[str, Any]:
    rows = body.get("endpoints") if isinstance(body, dict) else None
    if not isinstance(rows, list):
        raise HTTPException(502, "Das Dashboard liefert die Endpunkte in unbekannter Form")
    keep = ("id", "name", "base_url", "model", "models", "api_mode", "context_length", "has_api_key", "api_key_preview", "is_current", "source")
    cur = body.get("current")
    return {"endpoints": [{k: r.get(k) for k in keep} for r in rows if isinstance(r, dict)],
            "current": {k: cur.get(k, "") for k in ("provider", "model", "base_url")} if isinstance(cur, dict) else {}}


async def _list(dash: Dash, agent: str) -> dict[str, Any]:
    return _listing(await upstream(dash.request("GET", "/api/providers/custom-endpoints", params={"profile": agent})))


@router.get("/hermes-endpoints")
async def endpoints_read(target: Tgt, dash: Dash):
    return await _list(dash, target.agent.id)


@router.post("/hermes-endpoints")
async def endpoint_save(request: Request, target: Tgt, dash: Dash, req: EndpointIn, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-endpoints")
    payload = req.model_dump(exclude_none=True)
    if not payload.get("api_key"):
        payload.pop("api_key", None)  # leer = vorhandenen Schlüssel behalten
    out = await upstream(dash.request("POST", "/api/providers/custom-endpoints", body=payload, params={"profile": target.agent.id}))
    eid = out.get("id") if isinstance(out, dict) else None
    back = await _list(dash, target.agent.id)
    row = next((r for r in back["endpoints"] if r["id"] == eid), None)
    if not eid or row is None or row["base_url"].rstrip("/") != req.base_url:
        raise HTTPException(502, "Das Dashboard hat den Endpunkt nicht übernommen")
    audit(request, user, "endpoint.save", target, endpoint=eid, base_url=req.base_url, model=req.model)
    return {"ok": True, "id": eid, **back}


@router.post("/hermes-endpoints/validate")
async def endpoint_validate(request: Request, target: Tgt, dash: Dash, req: EndpointIn, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-endpoints")  # schickt den Schlüssel an eine Nutzer-URL: frisch + URL-Prüfung
    out = await upstream(dash.request("POST", "/api/providers/custom-endpoints/validate", body={"base_url": req.base_url, "api_key": req.api_key, "name": req.name, "model": req.model}, params={"profile": target.agent.id}))
    if not isinstance(out, dict) or "ok" not in out:
        raise HTTPException(502, "Das Dashboard liefert die Prüfung in unbekannter Form")
    audit(request, user, "endpoint.validate", target, base_url=req.base_url)
    return {"ok": bool(out["ok"]), "reachable": bool(out.get("reachable", True)), "message": str(out.get("message", ""))[:300],
            "models": [m for m in out.get("models", []) if isinstance(m, str)][:200]}


@router.post("/hermes-endpoints/{endpoint_id}/activate")
async def endpoint_activate(request: Request, endpoint_id: str, target: Tgt, dash: Dash, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-endpoints")
    await upstream(dash.request("POST", f"/api/providers/custom-endpoints/{endpoint_id}/activate", params={"profile": target.agent.id}))
    row = next((r for r in (await _list(dash, target.agent.id))["endpoints"] if r["id"] == endpoint_id), None)
    if row is None or not row["is_current"]:
        raise HTTPException(502, "Das Dashboard hat den Endpunkt nicht aktiviert")
    audit(request, user, "endpoint.activate", target, endpoint=endpoint_id)
    return {"ok": True, "id": endpoint_id}


@router.delete("/hermes-endpoints/{endpoint_id}")
async def endpoint_delete(request: Request, endpoint_id: str, target: Tgt, dash: Dash, confirm: str = Query(default=""), user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-endpoints")
    if confirm != endpoint_id:
        raise HTTPException(422, "Löschen: die Endpunkt-ID zur Bestätigung eingeben")
    await upstream(dash.request("DELETE", f"/api/providers/custom-endpoints/{endpoint_id}", params={"profile": target.agent.id}))
    if any(r["id"] == endpoint_id for r in (await _list(dash, target.agent.id))["endpoints"]):
        raise HTTPException(502, "Das Dashboard hat den Endpunkt nicht gelöscht")
    audit(request, user, "endpoint.delete", target, endpoint=endpoint_id)
    return {"ok": True}


@router.get("/hermes-local-models/status")
async def local_status(target: Tgt, dash: Dash):
    b = await upstream(dash.request("GET", "/api/local-models/status", params={"profile": target.agent.id}))
    if not isinstance(b, dict) or not isinstance(b.get("models"), list) or "server_running" not in b:
        raise HTTPException(502, "Das Dashboard liefert den Status lokaler Modelle in unbekannter Form")
    keep = ("enabled", "tag", "runtime_installed", "runtime_backend", "server_running", "active_model_id", "loaded_models", "models_dir")
    return {**{k: b.get(k) for k in keep}, "models": [{k: m.get(k) for k in ("id", "name", "size_bytes")} for m in b["models"] if isinstance(m, dict)]}
