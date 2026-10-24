"""Werkzeuge eines Hermes-Profils: ein- und ausschalten, Anbieter und Modell wählen, Werkzeug-Keys setzen.

Die Gruppen, Anbieter und Variablen kommen vom Dashboard, die WebUI baut nichts nach. Hermes selbst schützt vieles nicht serverseitig
(`PUT /api/env` schreibt jeden Namen, `POST /api/env/reveal` liefert Klartext, das Terminal-Backend lässt sich auf „keine Isolation“
stellen, `post-setup` lädt Programme). Darum steht hier nur, was eine Weboberfläche verantworten kann:

- Lesen: Gruppen, Anbieter mit „Schlüssel gesetzt: ja/nein“ (nie ein Wert), Modellkatalog, Terminal-Backends.
- Schreiben (frische Anmeldung): ein-/ausschalten, Anbieter, Modell, Werkzeug-Keys NUR für Variablen, die die Gruppe selbst nennt.
- Einschalten, das Software installieren kann (Anbieter mit `post_setup`, der laut Dashboard noch „needs_setup“ meldet), verlangt eine
  ausdrückliche Zustimmung. Hermes selbst prüft die Installation nur für `cua_driver`; für die anderen Schlüssel startet es beim Einschalten nichts.
- Nicht vorhanden: Terminal-Backend umstellen, `post-setup`, Computer-Use-Rechte, freies Schreiben/Löschen/Zeigen von Variablen.

Jede Änderung wird zurückgelesen; übernimmt das Dashboard sie nicht, antwortet die Route mit 502. Das Audit nennt Gruppen und
Variablennamen, nie Werte.
"""
from __future__ import annotations

import re
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from pydantic import BaseModel, Field

from ..auth import User, current_user, fresh_user
from .agents import Tgt, upstream
from .dashboard import Dash, audit

router = APIRouter(prefix="/bff/h/{host}/{runtime}/{agent}", dependencies=[Depends(current_user)])

Toolset = Annotated[str, Path(pattern=r"^[a-z][a-z0-9_]{0,39}$")]
ENV_KEY = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
PREVIEW = re.compile(r"^.{4}\.\.\..{4}$", re.S)
MAX_KEYS, MAX_VALUE = 20, 4096
LIST_FIELDS = ("name", "label", "description", "platform", "platform_label", "enabled", "configured", "tools")
PROVIDER_FIELDS = ("name", "badge", "tag", "post_setup", "requires_nous_auth", "is_active", "status", "web_backend", "capabilities")


class Toggle(BaseModel):
    enabled: bool
    accept_install: bool = False


class ProviderIn(BaseModel):
    provider: str = Field(min_length=1, max_length=120)
    capability: str | None = Field(default=None, pattern=r"^(search|extract)$")


class EnvIn(BaseModel):
    env: dict[str, str] = Field(min_length=1, max_length=MAX_KEYS)


class ModelIn(BaseModel):
    model: str = Field(min_length=1, max_length=200)
    provider: str | None = Field(default=None, max_length=120)


def pick(row: dict[str, Any], fields: tuple[str, ...]) -> dict[str, Any]:
    return {k: row[k] for k in fields if k in row}


def scope(target) -> dict[str, str]:
    return {"profile": target.agent.id}


async def _toolsets(target: Tgt, dash: Dash) -> list[dict[str, Any]]:
    rows = await upstream(dash.request("GET", "/api/tools/toolsets", params=scope(target)))
    if not isinstance(rows, list):
        raise HTTPException(502, "Das Dashboard liefert die Werkzeuge in einer unbekannten Form")
    return [r for r in rows if isinstance(r, dict)]


async def _config(target: Tgt, dash: Dash, name: str) -> dict[str, Any]:
    body = await upstream(dash.request("GET", f"/api/tools/toolsets/{name}/config", params=scope(target)))
    if not isinstance(body, dict) or not isinstance(body.get("providers"), list):
        raise HTTPException(502, "Das Dashboard liefert die Werkzeug-Einstellungen in einer unbekannten Form")
    return body


def _providers(body: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for p in body["providers"]:
        if not isinstance(p, dict):
            continue
        row = pick(p, PROVIDER_FIELDS)
        row["env_vars"] = [{"key": v.get("key"), "prompt": v.get("prompt"), "url": v.get("url"), "is_set": bool(v.get("is_set"))}
                           for v in p.get("env_vars", []) if isinstance(v, dict) and isinstance(v.get("key"), str)]
        out.append(row)
    return out


def _declared_keys(body: dict[str, Any]) -> set[str]:
    return {v["key"] for p in _providers(body) for v in p["env_vars"]}


def _check_value(key: str, value: str) -> str:
    value = value.strip()
    if not value:
        return ""
    if len(value) > MAX_VALUE or any(c in value for c in "\r\n\x00"):
        raise HTTPException(422, f"{key}: ungültiger Wert (zu lang oder mit Zeilenumbruch)")
    if value.startswith("«redacted") or value == "***" or PREVIEW.match(value):
        raise HTTPException(422, f"{key}: das ist eine geschwärzte Vorschau, kein Schlüssel")
    return value


async def _known(target: Tgt, dash: Dash, name: str) -> dict[str, Any]:
    row = next((r for r in await _toolsets(target, dash) if r.get("name") == name), None)
    if row is None:
        raise HTTPException(404, "Unbekannte Werkzeuggruppe")
    return row


def _limit(request: Request, user: User) -> None:
    request.app.state.limiter.check(f"{user.id}:tools")


@router.get("/tools")
async def list_tools(target: Tgt, dash: Dash):
    return {"toolsets": [pick(r, LIST_FIELDS) for r in await _toolsets(target, dash)]}


@router.get("/terminal-backends")
async def terminal_backends(target: Tgt, dash: Dash):
    body = await upstream(dash.request("GET", "/api/tools/terminal/backends", params=scope(target)))
    if not isinstance(body, dict) or not isinstance(body.get("backends"), list):
        raise HTTPException(502, "Das Dashboard liefert die Terminal-Backends in einer unbekannten Form")
    return {"active": body.get("active"), "backends": [pick(b, ("name", "label", "description", "active", "status", "detail")) for b in body["backends"] if isinstance(b, dict)]}


@router.get("/tools/{name}")
async def tool_config(name: Toolset, target: Tgt, dash: Dash):
    await _known(target, dash, name)
    body = await _config(target, dash, name)
    return {"name": name, "has_category": bool(body.get("has_category")), "active_provider": body.get("active_provider"), "providers": _providers(body)}


@router.get("/tools/{name}/models")
async def tool_models(name: Toolset, target: Tgt, dash: Dash):
    await _known(target, dash, name)
    body = await upstream(dash.request("GET", f"/api/tools/toolsets/{name}/models", params=scope(target)))
    if not isinstance(body, dict):
        raise HTTPException(502, "Das Dashboard liefert den Modellkatalog in einer unbekannten Form")
    models = [pick(m, ("id", "display", "speed", "strengths", "price")) for m in body.get("models", []) if isinstance(m, dict)]
    return {"name": name, "has_models": bool(body.get("has_models")), "provider": body.get("provider"), "models": models, "current": body.get("current"), "default": body.get("default")}


@router.put("/tools/{name}")
async def toggle_tool(request: Request, name: Toolset, target: Tgt, dash: Dash, req: Toggle, user: User = Depends(fresh_user)):
    _limit(request, user)
    await _known(target, dash, name)
    installs = []
    if req.enabled:
        # Hermes startet beim Einschalten nur dann eine Installation, wenn sie fehlt; das Dashboard meldet das als Status „needs_setup“.
        installs = sorted({p["post_setup"] for p in _providers(await _config(target, dash, name)) if p.get("post_setup") and p.get("status") == "needs_setup"})
        if installs and not req.accept_install:
            raise HTTPException(409, {"code": "install_consent_required", "message": f"Das Einschalten kann Software installieren ({', '.join(installs)}). Bitte ausdrücklich zustimmen.", "installs": installs})
    result = await upstream(dash.request("PUT", f"/api/tools/toolsets/{name}", body={"enabled": req.enabled, "profile": target.agent.id}, params=scope(target)))
    after = next((r for r in await _toolsets(target, dash) if r.get("name") == name), None)
    if after is None or bool(after.get("enabled")) != req.enabled:
        raise HTTPException(502, "Das Dashboard hat die Änderung nicht übernommen")
    started = result.get("post_setup_started") if isinstance(result, dict) else None
    audit(request, user, "tools.toggle", target, toolset=name, enabled=req.enabled, post_setup=started)
    return {"ok": True, "name": name, "enabled": req.enabled, "post_setup_started": started}


@router.put("/tools/{name}/provider")
async def set_provider(request: Request, name: Toolset, target: Tgt, dash: Dash, req: ProviderIn, user: User = Depends(fresh_user)):
    _limit(request, user)
    if req.capability and name != "web":
        raise HTTPException(422, "Die Teilfunktion (Suche/Extraktion) gibt es nur für „web“")
    await _known(target, dash, name)
    if req.provider not in {p.get("name") for p in _providers(await _config(target, dash, name))}:
        raise HTTPException(422, "Diese Werkzeuggruppe kennt den Anbieter nicht")
    await upstream(dash.request("PUT", f"/api/tools/toolsets/{name}/provider", body={"provider": req.provider, "capability": req.capability, "profile": target.agent.id}, params=scope(target)))
    if not req.capability and (await _config(target, dash, name)).get("active_provider") != req.provider:
        raise HTTPException(502, "Das Dashboard hat die Änderung nicht übernommen")
    audit(request, user, "tools.provider", target, toolset=name, provider=req.provider, capability=req.capability)
    return {"ok": True, "name": name, "provider": req.provider, "capability": req.capability}


@router.put("/tools/{name}/env")
async def set_keys(request: Request, name: Toolset, target: Tgt, dash: Dash, req: EnvIn, user: User = Depends(fresh_user)):
    _limit(request, user)
    await _known(target, dash, name)
    declared = _declared_keys(await _config(target, dash, name))
    values: dict[str, str] = {}
    for key, raw in req.env.items():
        if not ENV_KEY.match(key):
            raise HTTPException(422, f"{key}: ungültiger Variablenname")
        if key not in declared:
            raise HTTPException(422, f"{key}: gehört nicht zu den Variablen dieser Werkzeuggruppe")
        values[key] = _check_value(key, raw)
    send = {k: v for k, v in values.items() if v}
    skipped = sorted(k for k, v in values.items() if not v)
    if send:
        await upstream(dash.request("PUT", f"/api/tools/toolsets/{name}/env", body={"env": send, "profile": target.agent.id}, params=scope(target)))
        now = {v["key"]: v["is_set"] for p in _providers(await _config(target, dash, name)) for v in p["env_vars"]}
        missing = sorted(k for k in send if not now.get(k))
        if missing:
            raise HTTPException(502, "Das Dashboard hat nicht übernommen: " + ", ".join(missing))
        audit(request, user, "tools.env", target, toolset=name, keys=sorted(send))
    return {"ok": True, "name": name, "saved": sorted(send), "skipped": skipped}


@router.put("/tools/{name}/model")
async def set_model(request: Request, name: Toolset, target: Tgt, dash: Dash, req: ModelIn, user: User = Depends(fresh_user)):
    _limit(request, user)
    await _known(target, dash, name)
    catalog = await upstream(dash.request("GET", f"/api/tools/toolsets/{name}/models", params=scope(target)))
    if not isinstance(catalog, dict) or req.model not in {m.get("id") for m in catalog.get("models", []) if isinstance(m, dict)}:
        raise HTTPException(422, "Diese Werkzeuggruppe kennt das Modell nicht")
    await upstream(dash.request("PUT", f"/api/tools/toolsets/{name}/model", body={"model": req.model, "provider": req.provider, "profile": target.agent.id}, params=scope(target)))
    body = await upstream(dash.request("GET", f"/api/tools/toolsets/{name}/models", params=scope(target)))
    if not isinstance(body, dict) or body.get("current") != req.model:
        raise HTTPException(502, "Das Dashboard hat die Änderung nicht übernommen")
    audit(request, user, "tools.model", target, toolset=name, model=req.model)
    return {"ok": True, "name": name, "model": req.model}
