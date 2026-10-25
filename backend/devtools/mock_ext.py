"""Dashboard-Ersatz für das Paket ext: Skills, Skills-Hub, MCP und Plugins in den echten Antwortformen (Fixture `ext_real.json`, Quelltext
hermes_cli/web_routers/{skills,mcp,dashboard_ui}.py). Zustand liegt in `app.state.s`; Schreibaufrufe werden in `calls` festgehalten.

`create_registry()` ersetzt ein MCP-Registry (`/v0/servers`) samt Weiterleitung und Übergröße für die SSRF-Tests.
Start: uvicorn devtools.mock_ext:app --port 9123
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response

FIXTURE = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "ext_real.json"
SKILL_TEXT = "---\nname: {n}\ndescription: Beispiel\n---\n# {n}\n"


def real() -> dict[str, Any]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


class State:
    def __init__(self, verdict: str = "safe"):
        r = real()
        self.fx = r
        self.skills = [dict(s) for s in r["skills"]] + [
            {"name": "gamma", "description": "Aus dem Hub", "category": "beispiel", "enabled": True, "usage": 2, "provenance": "hub"},
            {"name": "alpha", "description": "Eigener Skill", "category": None, "enabled": False, "usage": 0, "provenance": "agent"}]
        self.contents = {s["name"]: SKILL_TEXT.format(n=s["name"]) for s in self.skills}
        self.contents["claude-code"] = r["skill_content"]["content"]
        self.mcp = copy.deepcopy(r["mcp_servers"]["servers"])
        self.mcp.append({"name": "plug", "transport": "http", "url": "https://example.com/mcp?token=geheim", "command": None, "args": [], "env": {},
                         "auth": "oauth", "enabled": True, "tools": ["a", "b"], "source": "plugin", "plugin": "demo"})
        self.plugins = copy.deepcopy(r["plugin_hub"]["plugins"]) + [
            {"name": "beta-plugin", "version": "0.2.0", "description": "Aus Git", "source": "user", "runtime_status": "disabled",
             "has_dashboard_manifest": False, "dashboard_manifest": None, "path": "/opt/example/plugins/beta", "can_remove": True,
             "can_update_git": True, "auth_required": False, "auth_command": "", "user_hidden": False, "removed_reason": None}]
        self.verdict = verdict
        self.calls: list[tuple[str, str, Any, dict[str, str]]] = []
        self.fail: dict[str, int] = {}  # Pfadteil -> Status
        self.bearer: dict[str, str] = {}


def create_mock(verdict: str = "safe") -> FastAPI:
    app = FastAPI()
    app.state.s = s = State(verdict)

    @app.middleware("http")
    async def record(request: Request, call_next):
        body = None
        if request.method in ("POST", "PUT", "DELETE"):
            raw = await request.body()
            body = json.loads(raw) if raw else None
        s.calls.append((request.method, request.url.path, body, dict(request.query_params)))
        for part, status in s.fail.items():
            if part in request.url.path:
                return JSONResponse({"detail": "Fehler im Mock"}, status_code=status)
        request.state.body = body
        return await call_next(request)

    def body_of(request: Request) -> dict[str, Any]:
        return request.state.body or {}

    # --- Skills ---
    @app.get("/api/skills")
    async def skills():
        return s.skills

    @app.put("/api/skills/toggle")
    async def toggle(request: Request):
        b = body_of(request)
        next(k for k in s.skills if k["name"] == b["name"])["enabled"] = b["enabled"]
        return {"ok": True, "name": b["name"], "enabled": b["enabled"]}

    @app.get("/api/skills/content")
    async def content(name: str):
        if name not in s.contents:
            raise HTTPException(404, f"Skill '{name}' not found.")
        return {"name": name, "content": s.contents[name], "path": f"/opt/example/skills/{name}/SKILL.md"}

    @app.put("/api/skills/content")
    async def save(request: Request):
        b = body_of(request)
        if b["name"] not in s.contents:
            raise HTTPException(404, "Skill not found")
        s.contents[b["name"]] = b["content"]
        return {"success": True, "path": "/opt/example/x"}

    @app.post("/api/skills")
    async def create(request: Request):
        b = body_of(request)
        if b["name"] in s.contents:
            raise HTTPException(400, "A skill named already exists")
        s.contents[b["name"]] = b["content"]
        s.skills.append({"name": b["name"], "description": "neu", "category": b.get("category"), "enabled": True, "usage": 0, "provenance": "agent"})
        return {"success": True, "path": "/opt/example/new"}

    @app.post("/api/skills/hub/{action}")
    async def hub_action(action: str, request: Request):
        return {"ok": True, "pid": 4242, "name": f"skills-{action}"}

    @app.get("/api/skills/hub/sources")
    async def sources():
        return s.fx["hub_sources"]

    @app.get("/api/skills/hub/official")
    async def official():
        return s.fx["hub_official"]

    @app.get("/api/skills/hub/search")
    async def search(q: str = "", source: str = "all", limit: int = 20):
        out = copy.deepcopy(s.fx["hub_search"])
        if source == "github":
            out["results"] = [{**out["results"][0], "source": "github", "identifier": "owner/repo/skills/one", "name": "one"},
                              {**out["results"][0], "source": "github", "identifier": "other/repo/skills/two", "name": "two"}]
        elif source == "well-known":
            out["results"] = [{**out["results"][0], "source": "well-known", "identifier": f"well-known:{q}/demo", "name": "demo"}]
        return out

    @app.get("/api/skills/hub/preview")
    async def preview(identifier: str):
        if identifier.startswith("https://missing"):
            raise HTTPException(404, "nicht gefunden")
        return {**s.fx["hub_preview"], "identifier": identifier}

    @app.get("/api/skills/hub/scan")
    async def scan(identifier: str):
        out = {**s.fx["hub_scan"], "identifier": identifier}
        if s.verdict == "dangerous":
            out.update(verdict="dangerous", policy="block", summary="gefährliche Funde",
                       findings=[{"severity": "critical", "category": "exfiltration", "file": "SKILL.md", "line": 3, "description": "Sendet Daten nach außen"}],
                       severity_counts={"critical": 1, "high": 0, "medium": 0, "low": 0})
        elif s.verdict == "caution":
            out.update(verdict="caution", policy="ask", summary="Hinweise",
                       findings=[{"severity": "medium", "category": "network", "file": "run.sh", "line": 9, "description": "Ruft eine Adresse ab"}],
                       severity_counts={"critical": 0, "high": 0, "medium": 1, "low": 0})
        return out

    # --- MCP ---
    @app.get("/api/mcp/servers")
    async def mcp_list():
        return {"servers": s.mcp}

    @app.post("/api/mcp/servers")
    async def mcp_add(request: Request):
        b = body_of(request)
        if any(x["name"] == b["name"] for x in s.mcp):
            raise HTTPException(409, f"Server '{b['name']}' already exists")
        if b.get("bearer_token"):
            s.bearer[b["name"]] = b["bearer_token"]
        row = {"name": b["name"], "transport": "http" if b.get("url") else "stdio", "url": b.get("url"), "command": b.get("command"),
               "args": b.get("args", []), "env": {k: "***" for k in b.get("env", {})}, "auth": b.get("auth") if b.get("auth") != "none" else None,
               "enabled": True, "tools": None, "source": "config", "plugin": None}
        s.mcp.append(row)
        return row

    @app.put("/api/mcp/servers/{name}/enabled")
    async def mcp_enabled(name: str, request: Request):
        row = next((x for x in s.mcp if x["name"] == name), None)
        if row is None:
            raise HTTPException(404, "not found")
        row["enabled"] = body_of(request)["enabled"]
        return {"ok": True, "name": name, "enabled": row["enabled"]}

    @app.post("/api/mcp/servers/{name}/test")
    async def mcp_test(name: str):
        return {"ok": True, "tools": [{"name": "search", "description": "Suche"}, {"name": "fetch", "description": "Abruf", "schema_chars": 10}],
                "prompts": 1, "resources": 2}

    @app.post("/api/mcp/servers/{name}/auth")
    async def mcp_auth(name: str):
        return {"flow_id": "flow_abcdefgh", "status": "authorization_required", "authorization_url": "https://auth.example.com/authorize?state=x", "server_name": name}

    @app.get("/api/mcp/oauth/flows/{flow_id}")
    async def mcp_flow(flow_id: str):
        return {"flow_id": flow_id, "status": "completed", "tools": ["a"]}

    @app.delete("/api/mcp/servers/{name}")
    async def mcp_delete(name: str):
        if not any(x["name"] == name for x in s.mcp):
            raise HTTPException(404, "not found")
        s.mcp = [x for x in s.mcp if x["name"] != name]
        return {"ok": True}

    @app.put("/api/mcp/servers")
    async def mcp_replace_all(request: Request):
        servers = body_of(request).get("servers")
        if not isinstance(servers, dict) or not servers:
            raise HTTPException(400, "servers fehlt")
        s.calls.append(("PUT", "/api/mcp/servers", sorted(servers), {}))
        s.mcp = [{"name": n, "transport": "stdio", "url": None, "command": "x", "args": [], "env": {},
                  "auth": None, "enabled": True, "tools": None, "source": "config", "plugin": None} for n in sorted(servers)]
        return {"ok": True}

    @app.get("/api/mcp/catalog")
    async def mcp_catalog():
        entries = copy.deepcopy(s.fx["mcp_catalog"]["entries"])
        # Katalogeintrag mit Env-Variable (Form nach _catalog_entry_json), die echte Fixture enthält nur OAuth-Einträge.
        entries.append({**entries[0], "name": "beta-db", "description": "Datenbank-Zugriff", "transport": "stdio", "auth_type": "env", "command": "npx",
                        "args": ["-y", "beta-db-mcp"], "url": None, "required_env": [{"name": "BETA_DB_KEY", "prompt": "Zugangsschlüssel", "required": True}]})
        return {"entries": entries, "diagnostics": []}

    @app.post("/api/mcp/catalog/install")
    async def mcp_cat_install(request: Request):
        b = body_of(request)
        if b["name"] not in ("airtable", "beta-db", "algolia"):
            raise HTTPException(404, "No catalog entry")
        return {"ok": True, "name": b["name"]}

    # --- Plugins ---
    @app.get("/api/dashboard/plugins/hub")
    async def plugin_hub():
        return {"plugins": s.plugins, "orphan_dashboard_plugins": [], "providers": {}}

    @app.get("/api/dashboard/plugins/catalog")
    async def plugin_catalog():
        return s.fx["plugin_catalog"]

    @app.post("/api/dashboard/agent-plugins/install")
    async def plugin_install(request: Request):
        b = body_of(request)
        if b["identifier"] == "needs/consent":
            return {"ok": False, "consent_required": True, "capabilities": {"provides_tools": ["x"]}}
        return {"ok": True, "name": "installed-plugin", "after_install_path": "/opt/example/secret-path"}

    @app.post("/api/dashboard/agent-plugins/{name}/{action}")
    async def plugin_action(name: str, action: str):
        row = next((p for p in s.plugins if p["name"] == name), None)
        if row is None:
            raise HTTPException(400, "Unknown plugin")
        if action in ("enable", "disable"):
            row["runtime_status"] = "enabled" if action == "enable" else "disabled"
        return {"ok": True, "name": name}

    @app.delete("/api/dashboard/agent-plugins/{name}")
    async def plugin_delete(name: str):
        s.plugins = [p for p in s.plugins if p["name"] != name]
        return {"ok": True}

    return app


def registry_server(name: str, **extra: Any) -> dict[str, Any]:
    return {"server": {"name": name, "description": "Beispiel", "version": "1.2.0", "repository": {"url": "https://example.com/r"}, **extra},
            "_meta": {}}


def create_registry() -> FastAPI:
    """Form der offiziellen API (GET /v0/servers?search=&limit=&cursor=), gekürzt."""
    app = FastAPI()
    app.state.hits = []

    @app.get("/v0/servers")
    async def servers(request: Request, search: str = "", limit: int = 30, cursor: str = "", version: str = ""):
        app.state.hits.append(dict(request.query_params))
        return {"servers": [
            registry_server("io.example/alpha-mcp", packages=[{"registryType": "npm", "identifier": "alpha-mcp", "version": "1.2.0", "transport": {"type": "stdio"},
                                                              "environmentVariables": [{"name": "ALPHA_TOKEN", "description": "Zugang", "isRequired": True, "isSecret": True}]}]),
            registry_server("io.example/beta", remotes=[{"type": "streamable-http", "url": "https://mcp.example.com/mcp?key=geheim"}]),
            registry_server("io.example/gamma", packages=[{"registryType": "oci", "identifier": "example/gamma"}]),
        ], "metadata": {"nextCursor": "next1", "count": 3}}

    @app.get("/redir/{where}/v0/servers")
    async def redir(where: str):
        target = {"same": "/v0/servers", "other": "https://evil.example.org/v0/servers", "private": "https://10.0.0.5/v0/servers"}[where]
        return Response(status_code=302, headers={"location": target})

    @app.get("/big/v0/servers")
    async def big():
        return Response(b'{"servers":[],"pad":"' + b"x" * (1024 * 1024 + 10) + b'"}', media_type="application/json")

    @app.get("/bad/v0/servers")
    async def bad():
        return Response(b"<html>", media_type="text/html")

    return app


app = create_mock()
