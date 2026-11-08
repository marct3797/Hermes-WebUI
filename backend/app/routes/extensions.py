"""Erweiterungen verwalten: Skills, MCP-Server und Plugins eines Hermes-Profils (über das Dashboard des Hosts).

Alle Routen liegen unter `/bff/h/{host}/_ext/{profile}/…`. Schreibende Wege verlangen `fresh_user` und schreiben einen Audit-Eintrag
nur mit Namen, Längen und Profil, nie mit Inhalt oder Env-Werten. Die Skill-Liste heißt `skill-list`, weil `…/{agent}/skills` der
Agent-Router sonst schluckt.
"""
from __future__ import annotations

import json
import re
from typing import Annotated, Any, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Path, Request

from ..auth import User, current_user, fresh_user
from ..extensions import (MCP_NAME_RE, PLUGIN_NAME_RE, SKILL_OLD_RE, CatalogInstall, McpNew, PluginInstall, PluginUpdate, SkillNew, SkillSave,
                          Toggle, check_skill_content, mcp_catalog_view, mcp_test_view, mcp_view, plugin_catalog_view, plugin_view, skill_view)
from ._dash import dash
from .operations import HostId, ProfileId

router = APIRouter(prefix="/bff")
P = "/h/{host}/_ext/{profile}"
SkillName = Annotated[str, Path(pattern=SKILL_OLD_RE)]
McpName = Annotated[str, Path(pattern=MCP_NAME_RE)]
PluginName = Annotated[str, Path(pattern=PLUGIN_NAME_RE)]
FlowId = Annotated[str, Path(pattern=r"^[A-Za-z0-9_-]{8,64}$")]


def rec(request: Request, user: User, action: str, host: str, **detail: Any) -> None:
    request.app.state.audit.record(action, user=user.id, target=host, **detail)


def scope(profile: str) -> dict[str, str]:
    return {"profile": profile}


def no_dots(name: str, what: str) -> None:
    if ".." in name:
        raise HTTPException(422, f"Ungültiger {what}-Name")


# --- Skills ---------------------------------------------------------------------------------------
async def skills_of(request: Request, host: str, profile: str) -> list[dict[str, Any]]:
    raw = await dash(request, host, "GET", "/api/skills", params=scope(profile))
    return [skill_view(s) for s in raw if isinstance(s, dict)] if isinstance(raw, list) else []


async def hub_skill(request: Request, host: str, profile: str, name: str) -> None:
    """Aktualisieren und Deinstallieren gibt es nur für Skills aus dem Hub, nie für mitgelieferte oder eigene."""
    skill = next((s for s in await skills_of(request, host, profile) if s["name"] == name), None)
    if skill is None:
        raise HTTPException(404, "Skill nicht gefunden")
    if skill["provenance"] != "hub":
        raise HTTPException(409, "Nur Skills aus dem Marktplatz lassen sich aktualisieren oder deinstallieren")


@router.get(P + "/skill-list")
async def skill_list(request: Request, host: HostId, profile: ProfileId, _user: User = Depends(current_user)):
    return {"skills": await skills_of(request, host, profile)}


@router.get(P + "/skills/{name}")
async def skill_get(request: Request, host: HostId, profile: ProfileId, name: SkillName, _user: User = Depends(current_user)):
    no_dots(name, "Skill")
    raw = await dash(request, host, "GET", "/api/skills/content", params={**scope(profile), "name": name}, missing="Skill nicht gefunden")
    return {"name": name, "content": raw.get("content", "") if isinstance(raw, dict) else ""}  # der lokale Pfad bleibt im BFF


@router.put(P + "/skills/{name}")
async def skill_save(request: Request, host: HostId, profile: ProfileId, name: SkillName, body: SkillSave, user: User = Depends(fresh_user)):
    no_dots(name, "Skill")
    try:
        check_skill_content(name, body.content)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    await dash(request, host, "PUT", "/api/skills/content", params=scope(profile), body={"name": name, "content": body.content})
    rec(request, user, "ext.skill.save", host, profile=profile, skill=name, size=len(body.content))
    return {"ok": True, "name": name}


@router.post(P + "/skills")
async def skill_create(request: Request, host: HostId, profile: ProfileId, body: SkillNew, user: User = Depends(fresh_user)):
    await dash(request, host, "POST", "/api/skills", params=scope(profile),
               body={"name": body.name, "content": body.content, "category": body.category})
    rec(request, user, "ext.skill.create", host, profile=profile, skill=body.name, category=body.category, size=len(body.content))
    return {"ok": True, "name": body.name}


@router.put(P + "/skills/{name}/enabled")
async def skill_toggle(request: Request, host: HostId, profile: ProfileId, name: SkillName, body: Toggle, user: User = Depends(fresh_user)):
    no_dots(name, "Skill")
    await dash(request, host, "PUT", "/api/skills/toggle", params=scope(profile), body={"name": name, "enabled": body.enabled})
    rec(request, user, "ext.skill.enable" if body.enabled else "ext.skill.disable", host, profile=profile, skill=name)
    return {"ok": True, "name": name, "enabled": body.enabled}


@router.post(P + "/skills/{name}/update")
async def skill_update(request: Request, host: HostId, profile: ProfileId, name: SkillName, user: User = Depends(fresh_user)):
    no_dots(name, "Skill")
    await hub_skill(request, host, profile, name)
    await dash(request, host, "POST", "/api/skills/hub/update", params=scope(profile), body={})  # Hermes aktualisiert alle Hub-Skills des Profils
    rec(request, user, "ext.skill.update", host, profile=profile, skill=name)
    return {"ok": True, "started": True}


@router.delete(P + "/skills/{name}")
async def skill_uninstall(request: Request, host: HostId, profile: ProfileId, name: SkillName, user: User = Depends(fresh_user)):
    no_dots(name, "Skill")
    await hub_skill(request, host, profile, name)
    await dash(request, host, "POST", "/api/skills/hub/uninstall", params=scope(profile), body={"name": name})
    rec(request, user, "ext.skill.uninstall", host, profile=profile, skill=name)
    return {"ok": True, "started": True}


# --- MCP ------------------------------------------------------------------------------------------
@router.get(P + "/mcp")
async def mcp_list(request: Request, host: HostId, profile: ProfileId, _user: User = Depends(current_user)):
    raw = await dash(request, host, "GET", "/api/mcp/servers", params=scope(profile))
    servers = raw.get("servers") if isinstance(raw, dict) else None
    return {"servers": [mcp_view(s) for s in servers if isinstance(s, dict)] if isinstance(servers, list) else []}


@router.post(P + "/mcp")
async def mcp_add(request: Request, host: HostId, profile: ProfileId, body: McpNew, user: User = Depends(fresh_user)):
    raw = await dash(request, host, "POST", "/api/mcp/servers", params=scope(profile), body=body.to_dashboard())
    rec(request, user, "ext.mcp.add", host, profile=profile, server=body.name, transport=body.transport, env=sorted(body.env),
        token=bool(body.bearer_token))
    return mcp_view(raw) if isinstance(raw, dict) else {"ok": True}


@router.get(P + "/mcp/catalog")
async def mcp_catalog(request: Request, host: HostId, profile: ProfileId, _user: User = Depends(current_user)):
    raw = await dash(request, host, "GET", "/api/mcp/catalog", params=scope(profile))
    entries = raw.get("entries") if isinstance(raw, dict) else None
    return {"entries": [mcp_catalog_view(e) for e in entries if isinstance(e, dict)] if isinstance(entries, list) else []}


@router.post(P + "/mcp/catalog/install")
async def mcp_catalog_install(request: Request, host: HostId, profile: ProfileId, body: CatalogInstall, user: User = Depends(fresh_user)):
    await dash(request, host, "POST", "/api/mcp/catalog/install", params=scope(profile),
               body={"name": body.name, "env": body.env, "enable": body.enable}, missing="Katalogeintrag nicht gefunden")
    rec(request, user, "ext.mcp.catalog_install", host, profile=profile, server=body.name, env=sorted(body.env))
    return {"ok": True, "name": body.name}


@router.get(P + "/mcp/oauth/{flow_id}")
async def mcp_oauth_status(request: Request, host: HostId, profile: ProfileId, flow_id: FlowId, _user: User = Depends(current_user)):
    raw = await dash(request, host, "GET", f"/api/mcp/oauth/flows/{quote(flow_id, safe='')}", missing="Die Anmeldung ist abgelaufen")
    return raw if isinstance(raw, dict) else {}


@router.put(P + "/mcp/{name}/enabled")
async def mcp_toggle(request: Request, host: HostId, profile: ProfileId, name: McpName, body: Toggle, user: User = Depends(fresh_user)):
    await dash(request, host, "PUT", f"/api/mcp/servers/{quote(name, safe='')}/enabled", params=scope(profile), body={"enabled": body.enabled}, missing="Server nicht gefunden")
    rec(request, user, "ext.mcp.enable" if body.enabled else "ext.mcp.disable", host, profile=profile, server=name)
    return {"ok": True, "name": name, "enabled": body.enabled}


@router.post(P + "/mcp/{name}/test")
async def mcp_test(request: Request, host: HostId, profile: ProfileId, name: McpName, user: User = Depends(fresh_user)):
    raw = await dash(request, host, "POST", f"/api/mcp/servers/{quote(name, safe='')}/test", params=scope(profile), missing="Server nicht gefunden")
    rec(request, user, "ext.mcp.test", host, profile=profile, server=name)
    return mcp_test_view(raw)


@router.post(P + "/mcp/{name}/auth")
async def mcp_auth(request: Request, host: HostId, profile: ProfileId, name: McpName, user: User = Depends(fresh_user)):
    raw = await dash(request, host, "POST", f"/api/mcp/servers/{quote(name, safe='')}/auth", params=scope(profile), missing="Server nicht gefunden")
    rec(request, user, "ext.mcp.auth", host, profile=profile, server=name)
    return raw if isinstance(raw, dict) else {}


@router.delete(P + "/mcp/{name}")
async def mcp_remove(request: Request, host: HostId, profile: ProfileId, name: McpName, user: User = Depends(fresh_user)):
    await dash(request, host, "DELETE", f"/api/mcp/servers/{quote(name, safe='')}", params=scope(profile), missing="Server nicht gefunden")
    rec(request, user, "ext.mcp.remove", host, profile=profile, server=name)
    return {"ok": True}


@router.put(P + "/mcp")
async def mcp_replace(request: Request, host: HostId, profile: ProfileId, body: dict[str, Any], user: User = Depends(fresh_user)):
    """Die ganze MCP-Serverliste ersetzen. Bestätigung: „ERSETZEN“ eintippen. Zählt nur Namen, nie Inhalte."""
    raw = body.get("servers") if isinstance(body, dict) else None
    if not isinstance(raw, dict) or not raw or len(raw) > 100:
        raise HTTPException(422, "Liste: 1 bis 100 Server mit Namen")
    if len(json.dumps(raw, default=str)) > 100_000:
        raise HTTPException(422, "Liste: zu groß (höchstens 100 KB)")
    for name in raw:
        if not isinstance(name, str) or not re.match(MCP_NAME_RE, name):
            raise HTTPException(422, f"Servername ungültig: {str(name)[:64]}")
    if body.get("confirm") != "ERSETZEN":
        raise HTTPException(422, "Ersetzen: „ERSETZEN“ zur Bestätigung eintippen. Das löscht alle Server auf einmal.")
    await dash(request, host, "PUT", "/api/mcp/servers", params=scope(profile), body={"servers": raw})
    after = await dash(request, host, "GET", "/api/mcp/servers", params=scope(profile))
    names = {s.get("name") for s in (after.get("servers") if isinstance(after, dict) else []) if isinstance(s, dict)}
    if set(raw) != names:
        raise HTTPException(502, "Das Dashboard hat die Liste nicht übernommen")
    rec(request, user, "ext.mcp.replace", host, profile=profile, servers=len(raw))
    return {"ok": True, "servers": sorted(set(raw))}


# --- Plugins (gelten für den Host, die Profil-Angabe wählt nur die Sicht des Hubs) ------------------
@router.get(P + "/plugins")
async def plugin_list(request: Request, host: HostId, profile: ProfileId, _user: User = Depends(current_user)):
    raw = await dash(request, host, "GET", "/api/dashboard/plugins/hub", params=scope(profile))
    plugins = raw.get("plugins") if isinstance(raw, dict) else None
    return {"plugins": [plugin_view(p) for p in plugins if isinstance(p, dict)] if isinstance(plugins, list) else []}


@router.get(P + "/plugins/catalog")
async def plugin_catalog(request: Request, host: HostId, profile: ProfileId, _user: User = Depends(current_user)):
    raw = await dash(request, host, "GET", "/api/dashboard/plugins/catalog")
    entries = raw.get("entries") if isinstance(raw, dict) else None
    return {"entries": [plugin_catalog_view(e) for e in entries if isinstance(e, dict)] if isinstance(entries, list) else []}


def _action_result(raw: Any) -> dict[str, Any]:
    """Nur Statusfelder weitergeben: `consent_required` (Rückfrage), Name, Hinweis; keine Pfade."""
    raw = raw if isinstance(raw, dict) else {}
    out: dict[str, Any] = {"ok": raw.get("ok") is not False and not raw.get("consent_required")}
    for key in ("consent_required", "name", "message", "capabilities", "delta"):
        if key in raw:
            out[key] = raw[key]
    return out


@router.post(P + "/plugins/install")
async def plugin_install(request: Request, host: HostId, profile: ProfileId, body: PluginInstall, user: User = Depends(fresh_user)):
    raw = await dash(request, host, "POST", "/api/dashboard/agent-plugins/install",
                     body={"identifier": body.identifier, "catalog_name": body.catalog_name, "ref": body.ref, "force": body.force, "enable": body.enable})
    rec(request, user, "ext.plugin.install", host, profile=profile, identifier=body.identifier or body.catalog_name, force=body.force)
    return _action_result(raw)


@router.post(P + "/plugins/{name}/{action}")
async def plugin_action(request: Request, host: HostId, profile: ProfileId, name: PluginName, action: Literal["enable", "disable", "update"],
                        body: PluginUpdate | None = None, user: User = Depends(fresh_user)):
    no_dots(name, "Plugin")
    send = {"accept_capabilities": True} if action == "update" and body and body.accept_capabilities else None
    raw = await dash(request, host, "POST", f"/api/dashboard/agent-plugins/{quote(name, safe='')}/{action}", body=send)
    rec(request, user, f"ext.plugin.{action}", host, profile=profile, plugin=name)
    return _action_result(raw)


@router.delete(P + "/plugins/{name}")
async def plugin_remove(request: Request, host: HostId, profile: ProfileId, name: PluginName, user: User = Depends(fresh_user)):
    no_dots(name, "Plugin")
    raw = await dash(request, host, "GET", "/api/dashboard/plugins/hub", params=scope(profile))
    hit = next((p for p in (raw.get("plugins") or []) if isinstance(p, dict) and p.get("name") == name), None) if isinstance(raw, dict) else None
    if hit is None:
        raise HTTPException(404, "Plugin nicht gefunden")
    if hit.get("can_remove") is not True:
        raise HTTPException(409, "Dieses Plugin lässt sich nicht entfernen (mitgeliefert)")
    await dash(request, host, "DELETE", f"/api/dashboard/agent-plugins/{quote(name, safe='')}")
    rec(request, user, "ext.plugin.remove", host, profile=profile, plugin=name)
    return {"ok": True}
