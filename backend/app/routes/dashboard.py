"""Profil-Routen über das Dashboard: SOUL.md, Beschreibung, Modell. /bff/h/<host>/<runtime>/<agent>/…

Ohne `dashboard` in der Host-Config ist alles hier "nicht eingerichtet"; die Seite erklärt dann, was fehlt.
Schreibende Aufrufe landen im Audit-Log, nie mit dem Inhalt (nur Längen).
"""
from __future__ import annotations

import asyncio
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from pydantic import BaseModel, Field, SecretStr, field_validator

from ..adapters import UpstreamError
from ..auth import User, current_user, fresh_user
from ..dashboard import (
    DESCRIPTION_MAX_CHARS, SOUL_MAX_CHARS, VERSION_RE, DashboardClient, SoulConflict, SoulHistory, digest, save_soul,
)
from ..hosts import Target
from ..providers import ACCOUNTS, build_matrix, build_overview, normalize_models, provider_keys
from ..security import client_ip
from .agents import HostId, RuntimeId, Tgt, audit as audit_target, upstream

router = APIRouter(prefix="/bff/h/{host}/{runtime}/{agent}", dependencies=[Depends(current_user)])
host_router = APIRouter(prefix="/bff/h/{host}/{runtime}", dependencies=[Depends(current_user)])  # eine Ebene höher: alle Profile einer Runtime

VersionId = Annotated[str, Path(pattern=VERSION_RE.pattern)]
NOT_CONFIGURED = "Für diese Runtime ist kein Dashboard eingerichtet"
PROFILE_FIELDS = ("name", "model", "provider", "description", "description_auto", "skill_count", "gateway_running", "has_env")


def dashboard_of(target: Tgt, request: Request) -> DashboardClient:
    cfg = target.runtime.dashboard
    if cfg is None:
        raise HTTPException(501, NOT_CONFIGURED)
    return DashboardClient(cfg, request.app.state.http, request.app.state.dash_cache)


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
        found = await DashboardClient(cfg, request.app.state.http, request.app.state.dash_cache).profile(target.agent.id)
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


# --- Anbieter: Keys, Anmeldung, Nutzung ------------------------------------------------------------------
async def _tolerated(coro):
    """Ergebnis oder die Fehlermeldung des Dashboards: eine fehlende Nebenquelle soll die Übersicht nicht kippen."""
    try:
        return await coro, None
    except UpstreamError as e:
        return None, e.detail


@router.get("/providers")
async def providers_overview(target: Tgt, dash: Dash, days: int = Query(30, ge=1, le=365)):
    """Anbieter dieses Profils mit Keys (geschwärzt), Anmeldestatus und Nutzung der letzten `days` Tage."""
    name = target.agent.id
    env_task = asyncio.ensure_future(dash.env(name))
    (oauth, oauth_err), (usage, usage_err) = await asyncio.gather(_tolerated(dash.oauth_providers(name)), _tolerated(dash.model_analytics(name, days)))
    env = await upstream(env_task)
    warnings = [f"{what} nicht ladbar: {err}" for what, err in (("Anmeldestatus", oauth_err), ("Nutzung", usage_err)) if err]
    return {**build_overview(env, oauth, usage, days), "warnings": warnings, **({"stale": True} if dash.stale else {})}


class KeyIn(BaseModel):
    var: str = Field(pattern=r"^[A-Z][A-Z0-9_]{1,63}$")
    value: SecretStr = Field(min_length=1, max_length=2000)

    @field_validator("value")
    @classmethod
    def single_line(cls, v: SecretStr) -> SecretStr:
        text = v.get_secret_value()
        if text != text.strip() or "\n" in text or "\r" in text:
            raise ValueError("Der Key darf keine Leerzeichen am Rand und keine Zeilenumbrüche enthalten")
        return v


async def _known_var(dash: DashboardClient, name: str, var: str) -> None:
    """Nur Variablen, die das Dashboard einem Anbieter zuordnet: über diese Route lässt sich keine beliebige Umgebungsvariable setzen."""
    if var not in provider_keys(await upstream(dash.env(name))):
        raise HTTPException(422, "Diese Variable gehört zu keinem Anbieter")


@router.post("/providers/validate")
async def validate_key(request: Request, target: Tgt, dash: Dash, req: KeyIn, user: User = Depends(current_user)):
    """Fragt beim Anbieter nach, ob der Key akzeptiert wird (ohne ihn zu speichern). `reachable: false` heißt: nicht prüfbar."""
    request.app.state.limiter.check(f"{user.id}:dashboard")
    await _known_var(dash, target.agent.id, req.var)
    result = await upstream(dash.validate_key(req.var, req.value.get_secret_value()))
    audit(request, user, "provider.validate", target, var=req.var)
    return {"ok": bool(result.get("ok")), "reachable": bool(result.get("reachable")), "message": str(result.get("message") or "")} if isinstance(result, dict) else {"ok": False, "reachable": False, "message": ""}


@router.put("/providers/key")
async def write_key(request: Request, target: Tgt, dash: Dash, req: KeyIn, user: User = Depends(current_user)):
    """Key eines Anbieters speichern oder ersetzen. Verlangt eine frische Anmeldung; im Audit-Log steht nur der Name der Variablen."""
    user = await fresh_user(request, user)
    request.app.state.limiter.check(f"{user.id}:dashboard")
    await _known_var(dash, target.agent.id, req.var)
    await upstream(dash.set_key(target.agent.id, req.var, req.value.get_secret_value()))
    audit(request, user, "provider.key", target, var=req.var, chars=len(req.value.get_secret_value()))
    return {"ok": True, "var": req.var}


# --- Modelle und Anmeldung eines Profils ---------------------------------------------------------------------
OAuthId = Annotated[str, Path(pattern=r"^[a-z0-9][a-z0-9-]{0,63}$")]
SessionId = Annotated[str, Path(pattern=r"^[A-Za-z0-9_-]{8,128}$")]


@router.get("/providers/models")
async def provider_models(target: Tgt, dash: Dash):
    """Anbieter und Modelle, aus denen dieses Profil wählen kann (angemeldete zuerst, der aktuelle ganz oben)."""
    providers = normalize_models(await upstream(dash.model_options(target.agent.id)))
    return {"providers": providers, **({"stale": True} if dash.stale else {})}


@router.post("/providers/oauth/{provider}/start")
async def oauth_start(request: Request, target: Tgt, dash: Dash, provider: OAuthId, user: User = Depends(current_user)):
    """Startet eine Anmeldung (Gerätecode oder Anthropic-Seite). Der Browser zeigt Code oder Link, das Dashboard wartet auf die Bestätigung."""
    user = await fresh_user(request, user)
    request.app.state.limiter.check(f"{user.id}:dashboard")
    body = await upstream(dash.oauth_start(target.agent.id, provider))
    audit(request, user, "provider.login.start", target, provider=provider)
    return body if isinstance(body, dict) else {}


@router.get("/providers/oauth/{provider}/poll/{session}")
async def oauth_poll(target: Tgt, dash: Dash, provider: OAuthId, session: SessionId):
    body = await upstream(dash.oauth_poll(target.agent.id, provider, session))
    return {k: body.get(k) for k in ("session_id", "status", "error_message", "expires_at")} if isinstance(body, dict) else {}


class CodeIn(BaseModel):
    session_id: str = Field(pattern=r"^[A-Za-z0-9_-]{8,128}$")
    code: SecretStr = Field(min_length=1, max_length=2000)


@router.post("/providers/oauth/{provider}/submit")
async def oauth_submit(request: Request, target: Tgt, dash: Dash, provider: OAuthId, req: CodeIn, user: User = Depends(current_user)):
    """Gibt den Code der Anthropic-Seite weiter und schließt die Anmeldung ab."""
    user = await fresh_user(request, user)
    request.app.state.limiter.check(f"{user.id}:dashboard")
    body = await upstream(dash.oauth_submit(target.agent.id, provider, req.session_id, req.code.get_secret_value()))
    audit(request, user, "provider.login.submit", target, provider=provider)
    return body if isinstance(body, dict) else {"ok": True}


# --- Alle Profile einer Runtime: Anbieter und Zugänge auf dem Host -----------------------------------------------
def runtime_of(request: Request, host: HostId, runtime: RuntimeId):
    reg = request.app.state.hosts.registry
    h = reg.host(host)
    rt = h.runtime(runtime) if h else None
    if rt is None:
        raise HTTPException(404, "Unbekannter Host oder unbekannte Runtime")
    return h, rt


@host_router.get("/_provider-matrix")
async def provider_matrix(request: Request, host: HostId, runtime: RuntimeId):
    """Je Profil Anbieter und Modell und je Zugang (Codex, Claude, OpenCode Go) der Stand in jedem Profil. Fehler sind Daten:
    ohne Dashboard oder bei einem Ausfall steht der Grund in `reason`, die Profile aus der Config bleiben sichtbar."""
    _, rt = runtime_of(request, host, runtime)
    fallback = [{"name": a.id, "model": None, "provider": None, "default": False, "gateway_running": False, "error": None} for a in rt.agents]
    empty = {"profiles": fallback, "accounts": [{"id": a["id"], "label": a["label"], "cli": a["cli"], "login": a["login"], "provider": a["provider"], "hint": a["hint"], "profiles": {}} for a in ACCOUNTS]}
    if rt.dashboard is None:
        return {"available": False, "reason": NOT_CONFIGURED, **empty}
    dash = DashboardClient(rt.dashboard, request.app.state.http, request.app.state.dash_cache)
    try:
        profiles = await dash.profiles()
    except UpstreamError as e:
        return {"available": False, "reason": e.detail, **empty}
    configured = {a.id for a in rt.agents}
    profiles = [p for p in profiles if p.get("name") in configured] or profiles  # die in der Config geführten Profile; sonst alle

    async def one(name: str):
        (env, env_err), (oauth, _) = await asyncio.gather(_tolerated(dash.env(name)), _tolerated(dash.oauth_providers(name)))
        return name, (build_overview(env, oauth, None, 0) if env is not None else None), env_err

    gate = asyncio.Semaphore(4)  # die Abfragen je Profil laufen parallel, aber nicht alle auf einmal

    async def limited(name: str):
        async with gate:
            return await one(name)

    rows = await asyncio.gather(*(limited(str(p["name"])) for p in profiles if p.get("name")))
    overviews = {name: ov for name, ov, _ in rows}
    errors = {name: err for name, _, err in rows if err}
    return {"available": True, "reason": None, **build_matrix(profiles, overviews, errors), **({"stale": True} if dash.stale else {})}
