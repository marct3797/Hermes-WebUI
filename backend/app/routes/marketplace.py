"""Integrierter Marktplatz: Suche in den Hub-Quellen des Hosts, Vorschau mit Sicherheitsprüfung, Installation in ein oder mehrere Profile,
MCP-Katalog und MCP-Registries sowie die eigenen Quellen (`marketplaces.json`).

Was das BFF selbst im Netz abruft (MCP-Registries), läuft durch den SSRF-Schutz aus `app/marketplace.py`; Hub-Quellen ruft Hermes ab.
"""
from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from pydantic import Field

from ..auth import User, current_user, fresh_user
from ..extensions import Strict, mcp_catalog_view, plugin_catalog_view, trim, valid_identifier
from ..marketplace import (KINDS, MAX_SOURCES, OFFICIAL_REGISTRY, Marketplaces, SourceError, check_public_url, fetch_json, registry_entries,
                           system_resolver)
from ..registry import AGENT_RE
from ._dash import dash
from .operations import HostId, ProfileId

router = APIRouter(prefix="/bff")
Profile = Annotated[str, Query(pattern=AGENT_RE.pattern)]
Text = Annotated[str, Query(max_length=100)]
SourceRef = Annotated[str, Query(pattern=r"^(all|[a-z0-9][a-z0-9-]{0,31}|custom:[a-z-]{3,16}-[0-9a-f]{8})$")]
SourceId = Annotated[str, Path(pattern=r"^[a-z-]{3,16}-[0-9a-f]{8}$")]
Ident = Annotated[str, Query(min_length=1, max_length=500)]


def store(request: Request) -> Marketplaces:
    st = request.app.state
    if getattr(st, "marketplaces", None) is None:
        s = st.settings
        st.marketplaces = Marketplaces(s.marketplaces_file or ((s.ui_file.parent if s.ui_file else s.hosts_file.parent) / "marketplaces.json"))
    return st.marketplaces


def fail(e: SourceError) -> HTTPException:
    return HTTPException(e.status, str(e))


def ident(value: str) -> str:
    try:
        return valid_identifier(value)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


def hit(m: dict[str, Any], installed: Any) -> dict[str, Any]:
    tags = [trim(t, 40) for t in (m.get("tags") or [])[:12]] if isinstance(m.get("tags"), list) else []
    i = trim(m.get("identifier"), 500)
    return {"name": trim(m.get("name"), 100), "description": trim(m.get("description"), 400), "source": trim(m.get("source"), 40), "identifier": i,
            "trust_level": trim(m.get("trust_level"), 20) or "community", "repo": trim(m.get("repo"), 200) or None, "tags": tags,
            "category": trim(m.get("category"), 48) or None, "installed": m.get("installed") is True or (isinstance(installed, (dict, list)) and i in installed)}


def of_category(r: dict[str, Any], category: str) -> bool:
    return not category or r["category"] == category or category in r["tags"][:3]


# --- Eigene Quellen ----------------------------------------------------------------------------------
class SourceBody(Strict):
    label: str = Field(min_length=1, max_length=60)
    kind: str = Field(pattern="^(" + "|".join(KINDS) + ")$")
    target: str = Field(min_length=1, max_length=300)


BUILTIN = {"id": "official-registry", "label": "Offizielles MCP-Registry", "kind": "mcp-registry", "target": OFFICIAL_REGISTRY, "builtin": True}


@router.get("/market/sources")
async def sources(request: Request, _user: User = Depends(current_user)):
    return {"builtin": [BUILTIN], "custom": store(request).list(), "max": MAX_SOURCES, "kinds": list(KINDS)}


@router.post("/market/sources")
async def source_add(request: Request, body: SourceBody, user: User = Depends(fresh_user)):
    try:
        if body.kind == "mcp-registry":
            await check_public_url(body.target.strip(), getattr(request.app.state, "resolver", system_resolver))
        entry = store(request).add(body.label, body.kind, body.target)
    except SourceError as e:
        raise fail(e) from e
    request.app.state.audit.record("market.source.add", user=user.id, target="market", source=entry["id"], kind=entry["kind"], address=entry["target"])
    return entry


@router.delete("/market/sources/{sid}")
async def source_remove(request: Request, sid: SourceId, user: User = Depends(fresh_user)):
    try:
        entry = store(request).remove(sid)
    except SourceError as e:
        raise fail(e) from e
    request.app.state.audit.record("market.source.remove", user=user.id, target="market", source=entry["id"], kind=entry["kind"])
    return {"ok": True}


@router.get("/h/{host}/_market/sources")
async def host_sources(request: Request, host: HostId, profile: Profile = "default", _user: User = Depends(current_user)):
    raw = await dash(request, host, "GET", "/api/skills/hub/sources", params={"profile": profile})
    hub = [{"id": s["id"], "ref": s["id"], "label": trim(s.get("label"), 60) or s["id"], "kind": "hub", "builtin": True,
            "searchable": s.get("searchable") is not False and s.get("available") is not False}
           for s in (raw.get("sources") if isinstance(raw, dict) else None) or [] if isinstance(s, dict) and isinstance(s.get("id"), str)]
    custom = [{**c, "ref": "custom:" + c["id"], "builtin": False, "searchable": c["kind"] != "plugin-git"} for c in store(request).list()]
    return {"sources": [*hub, {**BUILTIN, "ref": "official", "searchable": True}, *custom]}


# --- Skills ---------------------------------------------------------------------------------------
async def search(request: Request, host: str, profile: str, **params: str) -> dict[str, Any]:
    raw = await dash(request, host, "GET", "/api/skills/hub/search", params={"profile": profile, "limit": "50", **params})
    return raw if isinstance(raw, dict) else {}


@router.get("/h/{host}/_market/skills")
async def skills(request: Request, host: HostId, q: Text = "", source: SourceRef = "all", category: Text = "", profile: Profile = "default",
                 _user: User = Depends(current_user)):
    q, category = q.strip(), category.strip()
    results: list[dict[str, Any]] = []
    meta: dict[str, Any] = {"source_counts": {}, "timed_out": [], "featured": False, "note": None}
    needle = q.lower()

    def wanted(m: dict[str, Any]) -> bool:
        return not needle or needle in f"{m.get('name', '')} {m.get('description', '')}".lower()

    if source.startswith("custom:"):
        src = next((c for c in store(request).list() if c["id"] == source[7:]), None)
        if src is None:
            raise HTTPException(404, "Quelle nicht gefunden")
        if src["kind"] in ("mcp-registry", "plugin-git"):
            meta["note"] = "Diese Quelle liefert keine Skills, sie gehört zu MCP-Connectoren bzw. Plugins."
        elif src["kind"] == "url":
            try:
                one = await dash(request, host, "GET", "/api/skills/hub/preview", params={"profile": profile, "identifier": src["target"]})
                results = [hit(one, [])] if isinstance(one, dict) and wanted(one) else []
            except HTTPException as e:
                if e.status_code != 404:
                    raise
        elif src["kind"] == "well-known":
            data = await search(request, host, profile, q=src["target"], source="well-known")
            results = [hit(m, data.get("installed")) for m in data.get("results") or [] if isinstance(m, dict) and wanted(m)]
        elif not q:  # github
            meta["note"] = "Suchbegriff eingeben: GitHub-Quellen lassen sich nicht ohne Suche auflisten."
        else:
            data = await search(request, host, profile, q=q, source="github")
            prefix = src["target"].lower()
            results = [hit(m, data.get("installed")) for m in data.get("results") or []
                       if isinstance(m, dict) and str(m.get("identifier", "")).lower().startswith(prefix)]
    elif not q:
        if source == "official":
            raw = await dash(request, host, "GET", "/api/skills/hub/official", params={"profile": profile})
            results = [hit(m, []) for m in (raw.get("skills") if isinstance(raw, dict) else None) or [] if isinstance(m, dict)]
        elif source == "all":
            raw = await dash(request, host, "GET", "/api/skills/hub/sources", params={"profile": profile})
            raw = raw if isinstance(raw, dict) else {}
            results = [hit(m, raw.get("installed")) for m in raw.get("featured") or [] if isinstance(m, dict)]
            meta["featured"] = True
        else:
            meta["note"] = "Suchbegriff eingeben: diese Quelle lässt sich nicht ohne Suche auflisten."
    else:
        data = await search(request, host, profile, q=q, source=source)
        results = [hit(m, data.get("installed")) for m in data.get("results") or [] if isinstance(m, dict)]
        meta["source_counts"], meta["timed_out"] = data.get("source_counts") or {}, data.get("timed_out") or []
    cats = sorted({c for r in results for c in ([r["category"]] if r["category"] else r["tags"][:2])})[:40]
    return {"results": [r for r in results if of_category(r, category)], "categories": cats, **meta}


@router.get("/h/{host}/_market/skills/preview")
async def skill_preview(request: Request, host: HostId, identifier: Ident, profile: Profile = "default", _user: User = Depends(current_user)):
    raw = await dash(request, host, "GET", "/api/skills/hub/preview", params={"profile": profile, "identifier": ident(identifier)},
                     missing="Skill nicht gefunden")
    raw = raw if isinstance(raw, dict) else {}
    return {**hit(raw, []), "skill_md": trim(raw.get("skill_md"), 200_000), "files": [trim(f, 200) for f in (raw.get("files") or [])[:200]]}


def scan_view(raw: Any) -> dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    findings = [{"severity": trim(f.get("severity"), 12), "category": trim(f.get("category"), 60), "file": trim(f.get("file"), 200),
                 "line": f.get("line") if isinstance(f.get("line"), int) else None, "description": trim(f.get("description"), 300)}
                for f in (raw.get("findings") or [])[:100] if isinstance(f, dict)]
    t1 = raw.get("tier1") if isinstance(raw.get("tier1"), dict) else None
    return {"identifier": trim(raw.get("identifier"), 500), "name": trim(raw.get("name"), 100), "trust_level": trim(raw.get("trust_level"), 20),
            "verdict": trim(raw.get("verdict"), 20) or "unknown", "summary": trim(raw.get("summary"), 400), "policy": trim(raw.get("policy"), 10) or "ask",
            "policy_reason": trim(raw.get("policy_reason"), 300), "findings": findings,
            "severity_counts": raw.get("severity_counts") if isinstance(raw.get("severity_counts"), dict) else {},
            "tier1": {"passed": t1.get("passed") is True, "findings": len(t1.get("findings") or [])} if t1 else None}


@router.get("/h/{host}/_market/skills/scan")
async def skill_scan(request: Request, host: HostId, identifier: Ident, profile: Profile = "default", _user: User = Depends(current_user)):
    raw = await dash(request, host, "GET", "/api/skills/hub/scan", params={"profile": profile, "identifier": ident(identifier)},
                     missing="Skill nicht gefunden")
    return scan_view(raw)


class SkillInstall(Strict):
    identifier: str = Field(min_length=1, max_length=500)
    profiles: list[Annotated[str, Field(pattern=AGENT_RE.pattern)]] = Field(min_length=1, max_length=20)
    accept_risk: bool = False


@router.post("/h/{host}/_market/skills/install")
async def skill_install(request: Request, host: HostId, body: SkillInstall, user: User = Depends(fresh_user)):
    """Prüft vor jeder Installation selbst (nicht nur das UI): `block` wird nie installiert, alles außer `safe` nur mit `accept_risk`."""
    i = ident(body.identifier)
    profiles = list(dict.fromkeys(body.profiles))
    scan = scan_view(await dash(request, host, "GET", "/api/skills/hub/scan", params={"profile": profiles[0], "identifier": i}, missing="Skill nicht gefunden"))
    if scan["policy"] == "block":
        raise HTTPException(409, {"code": "scan_blocked", "message": "Die Sicherheitsprüfung blockiert die Installation: " + scan["summary"], "scan": scan})
    if scan["verdict"] != "safe" and not body.accept_risk:
        raise HTTPException(409, {"code": "scan_confirm_required", "message": "Die Sicherheitsprüfung meldet Funde: " + scan["summary"], "scan": scan})
    results = []
    for profile in profiles:
        try:
            await dash(request, host, "POST", "/api/skills/hub/install", params={"profile": profile}, body={"identifier": i})
            results.append({"profile": profile, "ok": True, "error": None})
            outcome = "ok"
        except HTTPException as e:
            results.append({"profile": profile, "ok": False, "error": trim(str(e.detail), 300)})
            outcome = "error"
        request.app.state.audit.record("market.skill.install", user=user.id, target=host, outcome=outcome, profile=profile, identifier=i,
                                       verdict=scan["verdict"], accepted_risk=body.accept_risk)
    return {"results": results, "scan": scan}


# --- MCP-Connectoren und Plugins --------------------------------------------------------------------
@router.get("/h/{host}/_market/mcp")
async def mcp_market(request: Request, host: HostId, q: Text = "", profile: Profile = "default", _user: User = Depends(current_user)):
    raw = await dash(request, host, "GET", "/api/mcp/catalog", params={"profile": profile})
    needle = q.strip().lower()
    entries = [mcp_catalog_view(e) for e in (raw.get("entries") if isinstance(raw, dict) else None) or [] if isinstance(e, dict)]
    return {"entries": [e for e in entries if not needle or needle in f"{e['name']} {e['description']}".lower()]}


@router.get("/h/{host}/_market/plugins")
async def plugin_market(request: Request, host: HostId, q: Text = "", category: Text = "", _user: User = Depends(current_user)):
    raw = await dash(request, host, "GET", "/api/dashboard/plugins/catalog")
    entries = [plugin_catalog_view(e) for e in (raw.get("entries") if isinstance(raw, dict) else None) or [] if isinstance(e, dict)]
    needle, category = q.strip().lower(), category.strip()
    cats = sorted({e["category"] for e in entries if e["category"]})
    custom = [c for c in store(request).list() if c["kind"] == "plugin-git"]
    return {"entries": [e for e in entries if (not needle or needle in f"{e['name']} {e['description']}".lower()) and (not category or e["category"] == category)],
            "categories": cats, "custom": custom}


@router.get("/market/registry")
async def registry(request: Request, source: Annotated[str, Query(pattern=r"^(official|[a-z-]{3,16}-[0-9a-f]{8})$")] = "official", q: Text = "",
                   cursor: Annotated[str, Query(max_length=200)] = "", _user: User = Depends(current_user)):
    if source == "official":
        base = OFFICIAL_REGISTRY
    else:
        src = next((c for c in store(request).list() if c["id"] == source and c["kind"] == "mcp-registry"), None)
        if src is None:
            raise HTTPException(404, "Registry nicht gefunden")
        base = src["target"]
    params = {"limit": "30", "version": "latest", **({"search": q.strip()} if q.strip() else {}), **({"cursor": cursor} if cursor else {})}
    try:
        data = await fetch_json(request.app.state.http, base.rstrip("/") + "/v0/servers", getattr(request.app.state, "resolver", system_resolver), params)
        entries, nxt = registry_entries(data)
    except SourceError as e:
        raise fail(e) from e
    return {"entries": entries, "cursor": nxt}
