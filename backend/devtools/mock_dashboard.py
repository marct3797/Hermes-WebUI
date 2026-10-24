"""Dashboard-Ersatz für Tests: die Profil-Routen von `hermes dashboard` (Form nach Hermes 0.19, Quelltext hermes_cli/web_server.py).

Gilt für `GET /api/profiles`, `GET|PUT /api/profiles/{name}/soul`, `PUT .../description` und `PUT .../model`, dazu `GET|PUT /api/env`,
`GET /api/providers/oauth`, `GET /api/analytics/models` und `POST /api/providers/validate` (Profil als `?profile=`). Unbekannte Profile
liefern 404, ein falscher Token 401. `drop_writes=True` quittiert das Schreiben, speichert aber nichts (Test für die Rücklese-Kontrolle).

Start: uvicorn devtools.mock_dashboard:app --port 9122
"""
from __future__ import annotations

import os
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

TOKEN = "dash-token"
SOULS = {
    "default": "Du bist ein hilfsbereiter Assistent.\n",
    "beta": "# Beta\n\nDu bewahrst Wissen und antwortest knapp.\n",
}


# Katalog der Env-Variablen in der Form von GET /api/env (Auszug): Anbieter-Keys, ein Werkzeug-Key und ein Kanal-Token.
ENV_CATALOG = {
    "ANTHROPIC_API_KEY": {"provider": "anthropic", "provider_label": "Anthropic", "category": "provider", "description": "Anthropic API key", "url": "https://console.anthropic.com/"},
    "OPENCODE_GO_API_KEY": {"provider": "opencode-go", "provider_label": "OpenCode Go", "category": "provider", "description": "OpenCode Go API key", "url": "https://opencode.ai/"},
    "OPENROUTER_API_KEY": {"provider": "openrouter", "provider_label": "OpenRouter", "category": "provider", "description": "OpenRouter API key", "url": "https://openrouter.ai/keys"},
    "GEMINI_API_KEY": {"provider": "gemini", "provider_label": "Google Gemini", "category": "provider", "description": "Gemini API key", "url": None},
    "FIRECRAWL_API_KEY": {"provider": "", "provider_label": "", "category": "tool", "description": "Web scraping", "url": None},
    "TELEGRAM_BOT_TOKEN": {"provider": "", "provider_label": "", "category": "messaging", "description": "Telegram", "url": None, "channel_managed": True},
}
OAUTH = [
    {"id": "anthropic", "name": "Anthropic", "flow": "pkce", "cli_command": "hermes auth add anthropic", "docs_url": None,
     "status": {"logged_in": False, "source": None, "source_label": None, "expires_at": None}},
    {"id": "openai-codex", "name": "OpenAI Codex", "flow": "device_code", "cli_command": "hermes auth add openai-codex", "docs_url": "https://example.invalid/codex",
     "status": {"logged_in": True, "source": "hermes_device", "source_label": "~/.codex/auth.json", "expires_at": "2026-11-01T00:00:00Z"}},
    {"id": "claude-code", "name": "Anthropic OAuth (Claude Code)", "flow": "external", "cli_command": "claude setup-token", "docs_url": None,
     "status": {"logged_in": False, "source": None, "source_label": None, "expires_at": None}},
]
# `GET /api/model/options` (Auszug): angemeldete Anbieter mit Modellen, der aktuelle zuerst.
MODEL_PROVIDERS = [
    {"slug": "anthropic", "name": "Anthropic", "models": ["claude-test", "claude-small"], "authenticated": True},
    {"slug": "openai-codex", "name": "OpenAI Codex", "models": ["gpt-test", "gpt-5.3-codex"], "authenticated": True},
    {"slug": "opencode-go", "name": "OpenCode Go", "models": ["glm-5.1", "kimi-k2.6"], "authenticated": False},
]
USAGE = [
    {"model": "claude-test", "provider": "anthropic", "input_tokens": 1_200_000, "output_tokens": 300_000, "estimated_cost": 4.5, "actual_cost": 0, "sessions": 12, "last_used_at": 1_792_000_000},
    {"model": "claude-small", "provider": "anthropic", "input_tokens": 100_000, "output_tokens": 20_000, "estimated_cost": 0.3, "actual_cost": 0.25, "sessions": 3, "last_used_at": 1_792_100_000},
    {"model": "gpt-test", "provider": "openai-codex", "input_tokens": 50_000, "output_tokens": 9_000, "estimated_cost": 0, "actual_cost": 0, "sessions": 2, "last_used_at": 1_791_000_000},
    {"model": "local-llm", "provider": "ollama", "input_tokens": 1_000, "output_tokens": 500, "estimated_cost": 0, "actual_cost": 0, "sessions": 1, "last_used_at": 1_790_000_000},
]


class SoulBody(BaseModel):
    content: str


class DescriptionBody(BaseModel):
    description: str = ""


class EnvBody(BaseModel):
    key: str
    value: str = ""


class ModelBody(BaseModel):
    provider: str
    model: str


def create_mock(token: str | None = None, profiles: tuple[str, ...] = ("default", "beta", "eta"), drop_writes: bool = False, quota: dict[str, Any] | None = None) -> FastAPI:
    app = FastAPI()
    state: dict[str, dict[str, Any]] = {
        name: {"soul": SOULS.get(name), "description": "", "description_auto": False, "provider": "anthropic", "model": "claude-test",
              "env": {"ANTHROPIC_API_KEY": "sk-ant-geheim-1234"} if name == "default" else {}}
        for name in profiles
    }
    app.state.profiles = state  # Tests lesen und ändern den Stand direkt

    @app.middleware("http")
    async def auth(request: Request, call_next):
        if token and request.headers.get("x-hermes-session-token") != token:
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)
        return await call_next(request)

    def profile_or_default(name: str | None) -> dict[str, Any]:
        return profile(name or "default")

    def profile(name: str) -> dict[str, Any]:
        if name not in state:
            raise HTTPException(404, "Profile not found")
        return state[name]

    app.state.quota_calls = []  # (profile, refresh) je Abruf; Tests prüfen damit das Rate-Limit

    @app.get("/api/plugins/ai-usage-tracker/usage")
    async def quota_usage(profile: str = "default", refresh: int = 0):
        if quota is None:  # wie ein Dashboard ohne das Plugin
            raise HTTPException(404, "Plugin not found")
        app.state.quota_calls.append((profile, refresh))
        return {**quota, "profile": profile}

    @app.get("/api/profiles")
    async def list_profiles():
        return {"profiles": [
            {"name": n, "path": f"/opt/data/profiles/{n}", "is_default": n == "default", "model": p["model"], "provider": p["provider"],
             "has_env": True, "skill_count": 12, "gateway_running": False, "description": p["description"],
             "description_auto": p["description_auto"], "distribution_name": None, "distribution_version": None,
             "distribution_source": None, "has_alias": False}
            for n, p in state.items()
        ]}

    @app.get("/api/profiles/{name}/soul")
    async def get_soul(name: str):
        soul = profile(name)["soul"]
        return {"content": soul or "", "exists": soul is not None}

    @app.put("/api/profiles/{name}/soul")
    async def put_soul(name: str, body: SoulBody):
        p = profile(name)
        if not drop_writes:
            p["soul"] = body.content
        return {"ok": True}

    @app.put("/api/profiles/{name}/description")
    async def put_description(name: str, body: DescriptionBody):
        p = profile(name)
        p["description"], p["description_auto"] = body.description.strip(), False
        return {"ok": True, "description": p["description"], "description_auto": False}

    @app.put("/api/profiles/{name}/model")
    async def put_model(name: str, body: ModelBody):
        p = profile(name)
        if not body.provider.strip() or not body.model.strip():
            raise HTTPException(400, "provider and model are required")
        p["provider"], p["model"] = body.provider.strip(), body.model.strip()
        return {"ok": True, "provider": p["provider"], "model": p["model"]}

    def redact(value: str) -> str:
        return f"{value[:4]}…{value[-4:]}" if len(value) > 8 else "…"

    @app.get("/api/env")
    async def get_env(profile: str | None = None):
        p = profile_or_default(profile)
        return {var: {"is_set": var in p["env"], "redacted_value": redact(p["env"][var]) if var in p["env"] else None, "description": meta["description"],
                      "url": meta["url"], "category": meta["category"], "is_password": True, "tools": [], "advanced": False,
                      "channel_managed": meta.get("channel_managed", False), "provider": meta["provider"], "provider_label": meta["provider_label"], "custom": False}
                for var, meta in ENV_CATALOG.items()}

    @app.put("/api/env")
    async def put_env(body: EnvBody, profile: str | None = None):
        if body.key not in ENV_CATALOG:
            raise HTTPException(400, "unknown variable")
        profile_or_default(profile)["env"][body.key] = body.value
        return {"ok": True, "key": body.key}

    @app.get("/api/providers/oauth")
    async def oauth(profile: str | None = None):
        profile_or_default(profile)
        return {"providers": OAUTH}

    @app.get("/api/model/options")
    async def model_options(profile: str | None = None):
        cur = profile_or_default(profile)
        return {"providers": [{**p, "is_current": p["slug"] == cur["provider"], "is_user_defined": False, "total_models": len(p["models"]), "source": "hermes"} for p in MODEL_PROVIDERS]}

    sessions: dict[str, dict[str, Any]] = {}
    app.state.oauth_sessions = sessions

    @app.post("/api/providers/oauth/{provider_id}/start")
    async def oauth_start(provider_id: str, profile: str | None = None):
        profile_or_default(profile)
        row = next((o for o in OAUTH if o["id"] == provider_id), None)
        if row is None or row["flow"] == "external":
            raise HTTPException(400, f"{provider_id} uses an external CLI")
        sid = f"sess-{len(sessions) + 1:04d}-abcdef"
        sessions[sid] = {"provider": provider_id, "status": "pending", "profile": profile}
        if row["flow"] == "pkce":
            return {"session_id": sid, "flow": "pkce", "auth_url": "https://claude.ai/oauth/authorize?code=true&state=mock", "expires_in": 600}
        return {"session_id": sid, "flow": "device_code", "user_code": "ABCD-EFGH", "verification_url": "https://auth.openai.com/codex/device?user_code=ABCD-EFGH", "expires_in": 900, "poll_interval": 5}

    @app.get("/api/providers/oauth/{provider_id}/poll/{session_id}")
    async def oauth_poll(provider_id: str, session_id: str, profile: str | None = None):
        sess = sessions.get(session_id)
        if sess is None:
            raise HTTPException(404, "Session not found or expired")
        return {"session_id": session_id, "status": sess["status"], "error_message": sess.get("error"), "expires_at": None}

    @app.post("/api/providers/oauth/{provider_id}/submit")
    async def oauth_submit(provider_id: str, body: dict[str, Any], profile: str | None = None):
        sess = sessions.get(body.get("session_id", ""))
        if sess is None:
            raise HTTPException(404, "Session not found or expired")
        sess["status"] = "approved" if body.get("code") == "gueltig" else "error"
        sess["error"] = None if sess["status"] == "approved" else "Der Code wurde abgelehnt"
        return {"ok": sess["status"] == "approved", "status": sess["status"]}

    @app.get("/api/analytics/models")
    async def analytics_models(days: int = 30, profile: str | None = None):
        profile_or_default(profile)
        return {"models": USAGE, "totals": {}, "period_days": days}

    @app.get("/api/skills")
    async def skills(profile: str | None = None):
        profile_or_default(profile)
        return [
            {"name": "plan", "description": "Zerlegt Aufgaben in Schritte.", "category": "software-development", "enabled": True, "usage": 4, "provenance": "bundled"},
            {"name": "mein-skill", "description": "Selbst geschrieben.", "category": None, "enabled": True, "usage": 0, "provenance": "agent"},
        ]

    @app.get("/api/tools/toolsets")
    async def toolsets(profile: str | None = None):
        profile_or_default(profile)
        return [
            {"name": "terminal", "label": "Terminal", "description": "Befehle ausführen.", "platform": "cli", "platform_label": "CLI", "enabled": True,
             "available": True, "configured": True, "tools": ["terminal", "process"]},
            {"name": "web", "label": "Web", "description": "Suchen.", "platform": "cli", "platform_label": "CLI", "enabled": False,
             "available": False, "configured": False, "tools": ["web_search"]},
        ]

    @app.get("/api/plugins/kanban/board")
    async def kanban_board(profile: str | None = None):
        profile_or_default(profile)
        task = lambda i, status, body="": {"id": f"t_{i}", "title": f"Aufgabe {i}", "body": body, "assignee": "worker", "status": status,
                                            "created_at": i, "completed_at": i if status == "done" else None}
        return {"columns": [{"name": "todo", "tasks": [task(1, "todo", "Zugang: password=hunter2\nSonst harmlos")]},
                            {"name": "done", "tasks": [task(i, "done") for i in range(2, 62)]}], "latest_event_id": 7}

    @app.get("/api/logs")
    async def logs(profile: str | None = None, lines: int = 100):
        profile_or_default(profile)
        return {"file": "agent", "lines": ["start ok\n", "Authorization: Bearer abc.def\n", "Quelle https://user:pw@example.test/pfad?token=1\n"][:lines]}

    @app.get("/api/mcp/servers")
    async def mcp_servers(profile: str | None = None):
        profile_or_default(profile)
        return {"servers": [{"name": "rag", "transport": "stdio", "url": "https://x.test/?key=geheim", "command": "rag-mcp", "args": ["--key", "geheim"],
                             "env": {"RAG_API_KEY": "geheim"}, "enabled": True, "source": "config", "plugin": None}]}

    @app.get("/api/dashboard/plugins/hub")
    async def plugin_hub(profile: str | None = None):
        profile_or_default(profile)
        return {"plugins": [{"name": "disk-cleanup", "version": "1.0", "description": "Räumt auf.", "runtime_status": "enabled", "path": "/geheim/pfad"}]}

    @app.get("/api/sessions/search")
    async def sessions_search(q: str):
        return {"results": [{"id": "s1", "session_id": "s1", "profile": "beta", "title": None, "snippet": f"Treffer für {q}"}]}

    @app.post("/api/providers/validate")
    async def validate(body: EnvBody):
        if body.value == "bad":
            return {"ok": False, "reachable": True, "message": "That API key was rejected. Double-check it and try again."}
        if body.value == "offline":
            return {"ok": False, "reachable": False, "message": "Could not reach the provider to verify the key."}
        return {"ok": True, "reachable": True, "message": ""}

    return app


# Wie das echte Dashboard: ein gesetzter HERMES_DASHBOARD_SESSION_TOKEN macht den Token zur Pflicht.
app = create_mock(token=os.environ.get("HERMES_DASHBOARD_SESSION_TOKEN"))
