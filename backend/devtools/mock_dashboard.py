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
# Werkzeug-Gruppen in der Form von GET /api/tools/toolsets und .../config (aus Hermes 0.22.5 gemessen, gekürzt).
TOOLSETS: dict[str, dict[str, Any]] = {
    "terminal": {"label": "Terminal", "description": "Befehle ausführen.", "tools": ["terminal", "process"]},
    "web": {"label": "Web", "description": "Suchen.", "tools": ["web_search"], "providers": [
        {"name": "Brave Search (Free)", "badge": "free", "tag": "Brave Search API", "web_backend": "brave", "capabilities": ["search"],
         "env_vars": [{"key": "BRAVE_SEARCH_API_KEY", "prompt": "Brave Search API key", "url": "https://brave.com/search/api/", "default": None}]},
        {"name": "Firecrawl Cloud", "badge": "paid", "tag": "Suche und Extraktion", "web_backend": "firecrawl", "capabilities": ["search", "extract"],
         "env_vars": [{"key": "FIRECRAWL_API_KEY", "prompt": "Firecrawl API key", "url": "https://firecrawl.dev/", "default": None}]}]},
    "image_gen": {"label": "Bilder", "description": "Bilder erzeugen.", "tools": ["image_generate"],
                  "providers": [{"name": "FAL.ai", "badge": "paid", "tag": "FLUX und mehr", "env_vars": [{"key": "FAL_KEY", "prompt": "FAL API key", "url": "https://fal.ai/dashboard/keys", "default": None}]}],
                  "models": [{"id": "flux-2-pro", "display": "FLUX 2 Pro", "speed": "~10s", "strengths": "Qualität", "price": "$0.05"},
                             {"id": "flux-2-klein", "display": "FLUX 2 Klein", "speed": "~3s", "strengths": "Tempo", "price": "$0.01"}]},
    "computer_use": {"label": "Computer Use", "description": "Bildschirm und Eingaben steuern.", "tools": ["computer_use"], "providers": [
        {"name": "Cua Driver", "badge": "local", "tag": "macOS", "post_setup": "cua_driver", "env_vars": []}]},
}

# Messaging-Plattformen in der Form von GET /api/messaging/platforms (aus Hermes 0.22.5 gemessen, gekürzt auf drei).
MESSAGING: dict[str, dict[str, Any]] = {
    "telegram": {"name": "Telegram", "description": "Hermes über Telegram nutzen.", "docs_url": "https://core.telegram.org/bots/features#botfather", "env": [
        {"key": "TELEGRAM_BOT_TOKEN", "required": True, "is_password": True, "prompt": "Bot token", "url": "https://t.me/BotFather"},
        {"key": "TELEGRAM_ALLOWED_USERS", "required": False, "is_password": False, "is_list": True, "prompt": "Allowed user IDs"}]},
    "discord": {"name": "Discord", "description": "Hermes über Discord nutzen.", "docs_url": "https://discord.com/developers", "env": [
        {"key": "DISCORD_BOT_TOKEN", "required": True, "is_password": True, "prompt": "Bot token"}]},
    "whatsapp": {"name": "WhatsApp", "description": "Hermes über WhatsApp nutzen.", "docs_url": "https://example.invalid/wa", "env": [
        {"key": "WHATSAPP_ALLOWED_USERS", "required": False, "is_password": False, "is_list": True, "prompt": "Allowed numbers"}]},
}

# Gedächtnis-Anbieter in der Form von GET /api/memory (aus Hermes 0.22.5 gemessen): einer braucht nur einen Key, einer ein fehlendes Programm.
MEMORY_PROVIDERS: dict[str, dict[str, Any]] = {
    "retaindb": {"description": "RetainDB, Cloud-Gedächtnis.", "env": {"api_key": "RETAINDB_API_KEY"}, "deps": [], "fields": [
        {"key": "api_key", "label": "Api Key", "kind": "secret", "description": "RetainDB API key", "required": True, "url": "https://retaindb.com", "options": []},
        {"key": "project", "label": "Project", "kind": "text", "description": "Projekt", "required": False, "url": "", "options": [], "default": ""},
        {"key": "mode", "label": "Mode", "kind": "select", "description": "Modus", "required": False, "url": "", "options": [{"value": "fast", "label": "fast"}, {"value": "deep", "label": "deep"}], "default": "fast"}]},
    "byterover": {"description": "ByteRover, Wissensbaum.", "env": {}, "deps": [{"name": "brv", "install": "curl -fsSL https://byterover.dev/install.sh | sh", "check": "brv --version"}], "fields": [
        {"key": "auto_extract", "label": "Auto Extract", "kind": "select", "description": "Automatisch", "required": False, "url": "", "options": [{"value": "true", "label": "true"}, {"value": "false", "label": "false"}], "default": "true"}]},
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


# `GET /api/config/schema` (Auszug): flache Schlüssel mit Punkt-Pfad, wie Hermes 0.22 sie liefert.
CONFIG_SCHEMA = {
    "model": {"type": "string", "description": "Default model", "category": "general"},
    "agent.service_tier": {"type": "select", "description": "Fast mode", "category": "agent", "options": ["", "normal", "fast"]},
    "agent.max_turns": {"type": "number", "description": "Max turns", "category": "agent"},
    "display.streaming": {"type": "boolean", "description": "Streaming", "category": "display"},
    "fallback_providers": {"type": "list", "description": "Fallback providers", "category": "general"},
    "web.api_key": {"type": "string", "description": "Search key", "category": "tools"},
}
CONFIG_ORDER = ["general", "agent", "display", "tools"]


def default_config() -> dict[str, Any]:
    return {"model": "claude-test", "agent": {"service_tier": "normal", "max_turns": 90}, "display": {"streaming": True},
            "fallback_providers": [], "web": {"api_key": "geheim-aus-der-config"}, "custom_providers": [{"name": "x"}]}


def deep_merge(base: dict[str, Any], extra: dict[str, Any]) -> dict[str, Any]:
    for k, v in extra.items():
        base[k] = deep_merge(base[k], v) if isinstance(v, dict) and isinstance(base.get(k), dict) else v
    return base


class SoulBody(BaseModel):
    content: str


class ConfigBody(BaseModel):
    config: dict[str, Any]
    profile: str | None = None


class DescriptionBody(BaseModel):
    description: str = ""


class EnvBody(BaseModel):
    key: str
    value: str = ""


class ModelBody(BaseModel):
    provider: str
    model: str

class ProfileCreateBody(BaseModel):
    name: str
    description: Any = None
    clone_from: Any = None
    clone_channels: bool = False

class ProfileRenameBody(BaseModel):
    new_name: str

class ConfirmBody(BaseModel):
    confirm: str = ""

class ActiveBody(BaseModel):
    name: str


class ToolToggleBody(BaseModel):
    enabled: bool
    profile: str | None = None


class ToolProviderBody(BaseModel):
    provider: str
    capability: str | None = None
    profile: str | None = None


class ToolEnvBody(BaseModel):
    env: dict[str, str]
    profile: str | None = None


class ToolModelBody(BaseModel):
    model: str
    provider: str | None = None
    profile: str | None = None


class MsgPlatformBody(BaseModel):
    enabled: bool | None = None
    env: dict[str, str] = {}
    clear_env: list[str] = []
    profile: str | None = None


class TelegramApplyBody(BaseModel):
    allowed_user_ids: list[str]
    profile: str | None = None


class MemProviderBody(BaseModel):
    provider: str


class MemResetBody(BaseModel):
    target: str = "all"


class MemConfigBody(BaseModel):
    values: dict[str, Any] = {}


def create_mock(token: str | None = None, profiles: tuple[str, ...] = ("default", "beta", "eta"), drop_writes: bool = False, quota: dict[str, Any] | None = None, env_put_error: dict[str, Any] | None = None) -> FastAPI:
    app = FastAPI()
    app.state.env_put_error = env_put_error  # {"var": ..., "status": 500, "detail": "..."}: PUT /api/env scheitert für diese Variable
    state: dict[str, dict[str, Any]] = {
        name: {"soul": SOULS.get(name), "description": "", "description_auto": False, "provider": "anthropic", "model": "claude-test",
              "env": {"ANTHROPIC_API_KEY": "sk-ant-geheim-1234"} if name == "default" else {}, "config": default_config()}
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

    app.state.profiles.setdefault("beta", {"soul": "# Beta\n", "provider": "nous", "model": "claude-test", "description": "", "description_auto": True, "env": {}, "memory": {"active": "", "files": {"memory": 10, "user": 0}, "cfg": {}, "installed": set()}, "channels": False, "gateway_running": False})
    app.state.profile_calls = []  # (Methode, Pfad, Name); Import per Pfad darf nie darin vorkommen
    app.state.action_logs = {}

    @app.get("/api/profiles/active")
    async def profiles_active():
        return {"active": "default", "current": "default"}

    @app.post("/api/profiles/active")
    async def profiles_active_set(body: ActiveBody):
        profile(body.name)
        return {"ok": True, "active": body.name}

    @app.post("/api/profiles")
    async def profiles_create(body: ProfileCreateBody):
        if body.name in state:
            raise HTTPException(400, "exists")
        if str(body.clone_from or "") and str(body.clone_from) not in state:
            raise HTTPException(404, "Quelle fehlt")
        src = state.get(str(body.clone_from)) if body.clone_from else None
        created = {("POST-mit-clone_channels_wahr" if body.clone_channels else "plain"): True}
        app.state.profile_calls.append((("POST-mit-clone_channels_wahr") if body.clone_channels else "POST", "/api/profiles", body.name))
        state[body.name] = {"soul": (src or {}).get("soul"), "provider": "nous", "model": "claude-test", "description": "", "description_auto": True, "env": {}, "memory": {"active": "", "files": {"memory": 0, "user": 0}, "cfg": {}, "installed": set()}, "created": created}
        if src is not None and bool(body.clone_channels):
            state[body.name]["channels"] = True
        return {"ok": True, "name": body.name}

    @app.patch("/api/profiles/{name}")
    async def profiles_rename(name: str, body: ProfileRenameBody):
        p = profile(name)
        state[body.new_name] = p
        del state[name]
        return {"ok": True, "name": body.new_name}

    @app.delete("/api/profiles/{name}")
    async def profiles_delete(name: str, body: ConfirmBody | None = None):
        p = profile(name)
        stopped = bool(p.get("gateway_running"))
        del state[name]
        return {"ok": True, "gateway_stopped": stopped}

    @app.post("/api/profiles/{name}/export")
    async def profiles_export(name: str):
        profile(name)
        return {"ok": True, "archive": f"/opt/data/exports/{name}-20261024.tar.gz"}

    @app.post("/api/profiles/import")
    async def profiles_import(request: Request):
        ctype = request.headers.get("content-type") or ""
        if ctype.startswith("multipart/form-data"):
            form = await request.form()
            up = form.get("archive")
            data = await up.read() if up is not None and not isinstance(up, str) else b""
            if not data[:2] == b"PK":
                raise HTTPException(422, "Nur Profil-Archive (.tar.gz/.zip)")
            name = str(form.get("name") or "rueck")
            state[name] = {"soul": None, "provider": "nous", "model": "claude-test", "description": "", "description_auto": True, "env": {}, "memory": {"active": "", "files": {"memory": 0, "user": 0}, "cfg": {}, "installed": set()}}
            return {"ok": True, "name": name}
        body = await request.json()
        arch = body.get("archive")
        if not isinstance(arch, str) or not arch.strip():
            raise HTTPException(400, "archive fehlt")
        import tempfile as _tf
        if not arch.startswith(_tf.gettempdir() + "/"):
            raise HTTPException(422, "Nur Uploads ueber das BFF (temp-Datei), keine freien Pfade")
        name = str(body.get("name") or "rueck")
        state[name] = {"soul": None, "provider": "nous", "model": "claude-test", "description": "", "description_auto": True, "env": {}, "memory": {"active": "", "files": {"memory": 0, "user": 0}, "cfg": {}, "installed": set()}}
        return {"ok": True, "name": name}  # BFF meldet temp-Pfade; profile_calls bleibt leer als Beleg dafuer

    @app.get("/api/profiles/{name}/setup-command")
    async def profiles_setup(name: str):
        profile(name)
        return {"command": "hermes setup"}

    @app.post("/api/ops/doctor")
    async def ops_doctor():
        from datetime import datetime, timezone
        app.state.action_logs.setdefault("doctor", f"fertig {datetime.now(timezone.utc).isoformat()}")
        return {"ok": True, "action": "doctor"}

    # 1. Fassung (Lifecycle): /api/actions/{name}/status mit Schwärzung, weil Hermes dort Binär- und Geheimnismüll liefern kann.

    @app.post("/api/ops/backup")
    async def ops_backup():
        return {"ok": True, "archive": "/opt/data/exports/backup-beta-test.zip"}

    @app.get("/api/health")
    async def dash_health():
        return {"ok": True, "uptime_s": 42}

    @app.get("/api/hermes/update/check")
    async def update_check():
        return {"current": "mock-1", "available": None}

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
        app.state.profile_calls.append(("PUT", f"/api/profiles/{name}/description", body.description.strip()))
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

    @app.get("/api/config/schema")
    async def config_schema(profile: str | None = None):
        profile_or_default(profile)
        return {"fields": CONFIG_SCHEMA, "category_order": CONFIG_ORDER}

    @app.get("/api/config")
    async def get_config(profile: str | None = None):
        return profile_or_default(profile)["config"]

    @app.put("/api/config")
    async def put_config(body: ConfigBody, profile: str | None = None):
        p = profile_or_default(body.profile or profile)
        if not drop_writes:
            deep_merge(p["config"], body.config)
        return {"ok": True}

    @app.get("/api/env")
    async def get_env(profile: str | None = None):
        p = profile_or_default(profile)
        return {var: {"is_set": var in p["env"], "redacted_value": redact(p["env"][var]) if var in p["env"] else None, "description": meta["description"],
                      "url": meta["url"], "category": meta["category"], "is_password": True, "tools": [], "advanced": False,
                      "channel_managed": meta.get("channel_managed", False), "provider": meta["provider"], "provider_label": meta["provider_label"], "custom": False}
                for var, meta in ENV_CATALOG.items()}

    @app.put("/api/env")
    async def put_env(body: EnvBody, profile: str | None = None, request: Request = None):  # type: ignore[assignment]
        fail = request.app.state.env_put_error if request is not None else None
        if fail and body.key == fail.get("var"):
            return JSONResponse({"detail": fail.get("detail", "Dashboard-Fehler")}, status_code=int(fail.get("status", 500)))
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

    app.state.tool_calls = []  # (Methode, Pfad) jeder Werkzeug-Route; Tests belegen damit, was das BFF nie aufruft
    app.state.post_setups = []
    app.state.installed: set[str] = set()  # post_setup-Schlüssel, deren Installation als erledigt gilt

    def tools_of(prof: dict[str, Any]) -> dict[str, Any]:
        return prof.setdefault("tools", {"enabled": {n: n in ("terminal", "image_gen") for n in TOOLSETS}, "provider": {}, "model": {}, "backend": "local"})

    def toolset(name: str) -> dict[str, Any]:
        if name not in TOOLSETS:
            raise HTTPException(400, f"Unknown toolset: {name}")
        return TOOLSETS[name]

    def has_keys(prof: dict[str, Any], name: str) -> bool:
        provs = TOOLSETS[name].get("providers", [])
        return not provs or any(all(v["key"] in prof["env"] for v in pr["env_vars"]) for pr in provs)

    @app.get("/api/tools/toolsets")
    async def toolsets(profile: str | None = None):
        prof = profile_or_default(profile)
        st = tools_of(prof)
        return [{"name": n, "label": t["label"], "description": t["description"], "platform": "cli", "platform_label": "CLI", "enabled": st["enabled"][n],
                 "available": st["enabled"][n], "configured": has_keys(prof, n), "tools": t["tools"]} for n, t in TOOLSETS.items()]

    @app.get("/api/tools/toolsets/{name}/config")
    async def toolset_config(name: str, profile: str | None = None):
        prof = profile_or_default(profile)
        app.state.tool_calls.append(("GET", f"/api/tools/toolsets/{name}/config"))
        t = toolset(name)
        if not t.get("providers"):
            return {"name": name, "has_category": False, "providers": [], "active_provider": None}
        active = tools_of(prof)["provider"].get(name)
        rows = [{"name": pr["name"], "badge": pr["badge"], "tag": pr["tag"], "post_setup": pr.get("post_setup"), "requires_nous_auth": False, "managed_nous_feature": None,
                 "is_active": pr["name"] == active, "status": ("ready" if pr["post_setup"] in app.state.installed else "needs_setup") if pr.get("post_setup") else "ready" if all(v["key"] in prof["env"] for v in pr["env_vars"]) else "needs_keys",
                 "env_vars": [{"key": v["key"], "prompt": v["prompt"], "url": v.get("url"), "default": v.get("default"), "is_set": v["key"] in prof["env"]} for v in pr["env_vars"]],
                 **({"web_backend": pr["web_backend"], "capabilities": pr["capabilities"]} if "web_backend" in pr else {})} for pr in t["providers"]]
        return {"name": name, "has_category": True, "providers": rows, "active_provider": active}

    @app.put("/api/tools/toolsets/{name}")
    async def toolset_toggle(name: str, body: ToolToggleBody, profile: str | None = None):
        prof = profile_or_default(body.profile or profile)
        app.state.tool_calls.append(("PUT", f"/api/tools/toolsets/{name}"))
        t = toolset(name)
        if not drop_writes:
            tools_of(prof)["enabled"][name] = body.enabled
        started = None
        if body.enabled:
            started = next((pr["post_setup"] for pr in t.get("providers", []) if pr.get("post_setup") and pr["post_setup"] not in app.state.installed), None)
            if started:
                app.state.post_setups.append((body.profile or profile or "default", started))
        return {"ok": True, "name": name, "platform": "cli", "enabled": body.enabled, "post_setup_started": started}

    @app.put("/api/tools/toolsets/{name}/provider")
    async def toolset_provider(name: str, body: ToolProviderBody, profile: str | None = None):
        prof = profile_or_default(body.profile or profile)
        app.state.tool_calls.append(("PUT", f"/api/tools/toolsets/{name}/provider"))
        t = toolset(name)
        if body.provider not in [pr["name"] for pr in t.get("providers", [])]:
            raise HTTPException(400, f"Unknown provider: {body.provider}")
        if body.capability and name != "web":
            raise HTTPException(400, "capability is only valid for the web toolset")
        if not drop_writes:
            tools_of(prof)["provider"][name] = body.provider
        return {"ok": True, "name": name, "provider": body.provider, **({"capability": body.capability} if body.capability else {})}

    @app.put("/api/tools/toolsets/{name}/env")
    async def toolset_env(name: str, body: ToolEnvBody, profile: str | None = None):
        prof = profile_or_default(body.profile or profile)
        app.state.tool_calls.append(("PUT", f"/api/tools/toolsets/{name}/env"))
        t = toolset(name)
        allowed = {v["key"] for pr in t.get("providers", []) for v in pr["env_vars"]}
        unknown = sorted(set(body.env) - allowed)
        if unknown:
            raise HTTPException(400, f"Unknown env var(s) for toolset {name}: {', '.join(unknown)}")
        saved, skipped = [], []
        for key, value in body.env.items():
            if value.strip():
                if not drop_writes:
                    prof["env"][key] = value.strip()
                saved.append(key)
            else:
                skipped.append(key)
        return {"ok": True, "name": name, "saved": saved, "skipped": skipped, "is_set": {k: k in prof["env"] for k in allowed}}

    @app.get("/api/tools/toolsets/{name}/models")
    async def toolset_models(name: str, provider: str | None = None, profile: str | None = None):
        prof = profile_or_default(profile)
        app.state.tool_calls.append(("GET", f"/api/tools/toolsets/{name}/models"))
        cat = TOOLSETS.get(name, {}).get("models")
        if not cat:
            return {"name": name, "has_models": False, "models": [], "current": None, "default": None}
        return {"name": name, "has_models": True, "provider": "FAL.ai", "plugin": "fal", "models": cat, "current": tools_of(prof)["model"].get(name, cat[0]["id"]), "default": cat[0]["id"]}

    @app.put("/api/tools/toolsets/{name}/model")
    async def toolset_model(name: str, body: ToolModelBody, profile: str | None = None):
        prof = profile_or_default(body.profile or profile)
        app.state.tool_calls.append(("PUT", f"/api/tools/toolsets/{name}/model"))
        cat = TOOLSETS.get(name, {}).get("models")
        if not cat:
            raise HTTPException(400, f"{name} has no model catalog")
        if body.model not in [m["id"] for m in cat]:
            raise HTTPException(400, f"Unknown model: {body.model}")
        if not drop_writes:
            tools_of(prof)["model"][name] = body.model
        return {"ok": True, "name": name, "model": body.model, "plugin": "fal"}

    @app.get("/api/tools/terminal/backends")
    async def terminal_backends(profile: str | None = None):
        prof = profile_or_default(profile)
        app.state.tool_calls.append(("GET", "/api/tools/terminal/backends"))
        active = tools_of(prof)["backend"]
        return {"active": active, "backends": [
            {"name": "local", "label": "Local", "description": "Run commands directly on this machine. No isolation.", "active": active == "local", "status": "ready", "detail": ""},
            {"name": "docker", "label": "Docker / Podman", "description": "Run commands in an isolated container.", "active": active == "docker", "status": "needs_setup", "detail": "Docker CLI not found"}]}

    # Routen, die das BFF bewusst NICHT durchreicht. Das Mock führt sie aus, damit ein Test beweisen kann, dass sie nie ankommen.
    @app.put("/api/tools/terminal/backend")
    async def terminal_backend_set(body: dict[str, Any], profile: str | None = None):
        app.state.tool_calls.append(("PUT", "/api/tools/terminal/backend"))
        tools_of(profile_or_default(profile))["backend"] = body.get("backend", "local")
        return {"ok": True, "backend": body.get("backend")}

    @app.post("/api/tools/toolsets/{name}/post-setup")
    async def toolset_post_setup(name: str, body: dict[str, Any]):
        app.state.tool_calls.append(("POST", f"/api/tools/toolsets/{name}/post-setup"))
        return {"ok": True, "pid": 1, "name": "tools-post-setup", "key": body.get("key")}

    @app.post("/api/tools/computer-use/permissions/grant")
    async def computer_use_grant():
        app.state.tool_calls.append(("POST", "/api/tools/computer-use/permissions/grant"))
        return {"ok": True, "pid": 1, "name": "computer-use-grant"}

    app.state.gateway = {"running": False, "busy": False, "active_sessions": 0, "state": None}
    app.state.gateway_calls = []  # (Pfad, Query) jedes Gateway-Aufrufs
    app.state.msg_enabled = {}  # (Profil, Plattform) -> bool
    app.state.env_locked = False  # wie eine gesperrte .env: Hermes antwortet ok, schreibt aber nichts
    app.state.pairings = {}
    app.state.action_lines = ["gateway start ok", "Authorization: Bearer abc.def.ghi", "token=sk-secret-1234567890"]

    def platform_row(prof_name: str, prof: dict[str, Any], pid: str) -> dict[str, Any]:
        spec = MESSAGING[pid]
        enabled = app.state.msg_enabled.get((prof_name, pid), False)
        configured = all(v["key"] in prof["env"] for v in spec["env"] if v["required"])
        gw = app.state.gateway
        state = "disabled" if not enabled else "not_configured" if not configured else "gateway_stopped" if not gw["running"] else "connected"
        rows = []
        for v in spec["env"]:
            val = prof["env"].get(v["key"])
            rows.append({"key": v["key"], "required": v["required"], "is_set": val is not None, "redacted_value": "«redacted:" + val[:4] + "...»" if val and v["is_password"] else None,
                         "value": None if v["is_password"] else val or "", "description": v["prompt"], "prompt": v["prompt"], "help": "", "url": v.get("url"),
                         "is_password": v["is_password"], "is_list": v.get("is_list", False), "advanced": False})
        return {"id": pid, "name": spec["name"], "description": spec["description"], "docs_url": spec["docs_url"], "enabled": enabled, "configured": configured,
                "gateway_running": gw["running"], "state": state, "error_code": None, "error_message": "Zugang: password=hunter2 abgelehnt" if pid == "discord" and enabled else None,
                "updated_at": None, "home_channel": None, "ingress_url": None, "env_vars": rows, **({"whatsapp_setup": {"mode": "", "allowed_users_set": False, "home_channel_set": False}} if pid == "whatsapp" else {})}

    @app.get("/api/status")
    async def hermes_status(profile: str | None = None):
        gw = app.state.gateway
        return {"version": "0.22.5", "profile": "default", "ok": True, "gateway_running": gw["running"], "gateway_state": gw["state"], "gateway_platforms": {}, "active_agents": gw["active_sessions"],
                "gateway_busy": gw["busy"], "gateway_drainable": gw["busy"], "restart_drain_timeout": 0.0, "active_sessions": gw["active_sessions"], "install_id": "geheim-install-id",
                "components": {"gateway": {"status": "ok" if gw["running"] else "degraded", "state": "running" if gw["running"] else "stopped"}}}

    @app.get("/api/messaging/platforms")
    async def messaging_platforms(profile: str | None = None):
        prof = profile_or_default(profile)
        return {"env_path": "/home/user/.hermes/.env", "gateway_start_command": "hermes gateway start", "platforms": [platform_row(profile or "default", prof, p) for p in MESSAGING]}

    @app.put("/api/messaging/platforms/{pid}")
    async def messaging_put(pid: str, body: MsgPlatformBody, profile: str | None = None):
        name = body.profile or profile or "default"
        prof = profile_or_default(name)
        if pid not in MESSAGING:
            raise HTTPException(404, "Unknown messaging platform")
        allowed = {v["key"] for v in MESSAGING[pid]["env"]}
        for value in body.env.values():
            if value.startswith("echo:"):  # manche Plugin-Regeln nennen den abgelehnten Wert im Fehlertext
                raise HTTPException(400, f"Invalid value {value}")
        for key, value in {**body.env, **{k: "" for k in body.clear_env}}.items():
            if key not in allowed:
                raise HTTPException(400, f"{key} is not configurable for {MESSAGING[pid]['name']}")
            if value.startswith("«redacted") or value == "***":
                raise HTTPException(400, "Refusing to save a redacted credential preview")
        if not app.state.env_locked:
            for key, value in body.env.items():
                if value.strip():
                    prof["env"][key] = value.strip()
            for key in body.clear_env:
                prof["env"].pop(key, None)
            if body.enabled is not None and not drop_writes:
                app.state.msg_enabled[(name, pid)] = body.enabled
        return {"ok": True, "platform": pid, "hot_served": False}

    @app.post("/api/messaging/platforms/{pid}/test")
    async def messaging_test(pid: str, profile: str | None = None):
        row = platform_row(profile or "default", profile_or_default(profile), pid)
        return {"ok": row["state"] == "connected", "state": row["state"], "message": f"Zustand: {row['state']}"}

    def spawn(name: str, profile: str | None, **extra: Any) -> dict[str, Any]:
        profile_or_default(profile)
        app.state.gateway_calls.append((name, {"profile": profile, **extra}))
        return {"ok": True, "pid": 4242, "name": name}

    @app.post("/api/gateway/start")
    async def gateway_start(profile: str | None = None):
        app.state.gateway.update(running=True, state="running")
        return spawn("gateway-start", profile)

    @app.post("/api/gateway/stop")
    async def gateway_stop(profile: str | None = None, interrupt: bool = False):
        gw = app.state.gateway
        if gw["active_sessions"] and not interrupt:
            raise HTTPException(409, f"Refusing to stop the gateway: {gw['active_sessions']} live session(s) would be interrupted")
        gw.update(running=False, state=None, active_sessions=0, busy=False)
        return spawn("gateway-stop", profile, interrupt=interrupt)

    @app.post("/api/gateway/restart")
    async def gateway_restart(profile: str | None = None):
        app.state.gateway.update(running=True, state="running", active_sessions=0, busy=False)
        return spawn("gateway-restart", profile)

    @app.get("/api/actions/{name}/status")
    async def action_status(name: str, lines: int = 200):
        if name not in ("gateway-start", "gateway-stop", "gateway-restart", "tools-post-setup", "doctor"):
            raise HTTPException(404, "Unknown action")
        if name == "doctor":
            return {"name": name, "running": False, "exit_code": 0, "log": app.state.action_logs.get(name, "")}
        return {"name": name, "running": False, "exit_code": 0, "pid": 4242, "lines": app.state.action_lines[-lines:]}

    @app.post("/api/messaging/telegram/onboarding/start")
    async def tg_start(body: dict[str, Any]):
        pid = "pair_abc123"
        app.state.pairings[pid] = {"polls": 0, "bot_token": "123456:SECRET-BOT-TOKEN-FROM-TELEGRAM"}
        return {"pairing_id": pid, "suggested_username": "hermes_test_bot", "deep_link": app.state.deep_link, "qr_payload": app.state.deep_link, "expires_at": "2026-10-24T18:00:00Z"}

    app.state.deep_link = "https://t.me/newbot/hermes/hermes_test_bot"

    @app.get("/api/messaging/telegram/onboarding/{pairing_id}")
    async def tg_poll(pairing_id: str):
        rec = app.state.pairings.get(pairing_id)
        if rec is None:
            raise HTTPException(404, "Telegram setup session was not found. Start a new setup.")
        rec["polls"] += 1
        if rec["polls"] < 2:
            return {"status": "waiting", "expires_at": "2026-10-24T18:00:00Z"}
        return {"status": "ready", "bot_username": "hermes_test_bot", "owner_user_id": "424242", "expires_at": "2026-10-24T18:00:00Z"}

    @app.post("/api/messaging/telegram/onboarding/{pairing_id}/apply")
    async def tg_apply(pairing_id: str, body: TelegramApplyBody, profile: str | None = None):
        rec = app.state.pairings.get(pairing_id)
        name = body.profile or profile or "default"
        prof = profile_or_default(name)
        if rec is None:
            raise HTTPException(404, "Telegram setup session was not found. Start a new setup.")
        if rec["polls"] < 2:
            raise HTTPException(409, "Telegram setup is not ready yet.")
        if not body.allowed_user_ids or not all(i.isdigit() for i in body.allowed_user_ids):
            raise HTTPException(400, "Allowed Telegram user IDs must be numeric.")
        prof["env"]["TELEGRAM_BOT_TOKEN"] = rec["bot_token"]
        prof["env"]["TELEGRAM_ALLOWED_USERS"] = ",".join(body.allowed_user_ids)
        app.state.msg_enabled[(name, "telegram")] = True
        del app.state.pairings[pairing_id]
        app.state.gateway_calls.append(("telegram-apply", {"profile": name}))
        return {"ok": True, "platform": "telegram", "bot_username": "hermes_test_bot", "needs_restart": True, "restart_started": False, "restart_error": "Live sessions"}

    @app.delete("/api/messaging/telegram/onboarding/{pairing_id}")
    async def tg_cancel(pairing_id: str):
        app.state.pairings.pop(pairing_id, None)
        return {"ok": True}

    app.state.memory_calls = []  # (Methode, Pfad); `setup` darf nie darin vorkommen

    def mem(prof: dict[str, Any]) -> dict[str, Any]:
        return prof.setdefault("memory", {"active": "", "files": {"memory": 120, "user": 45}, "cfg": {}, "installed": set()})

    def mem_status(prof: dict[str, Any], name: str) -> str:
        spec = MEMORY_PROVIDERS[name]
        if spec["deps"] and name not in mem(prof)["installed"]:
            return "unavailable"
        return "ready" if all(v in prof["env"] for v in spec["env"].values()) else "needs_config"

    @app.get("/api/memory")
    async def memory_overview(profile: str | None = None):
        prof = profile_or_default(profile)
        st = mem(prof)
        return {"active": st["active"], "builtin_files": dict(st["files"]), "providers": [
            {"name": n, "description": s["description"], "available": mem_status(prof, n) != "unavailable", "configured": mem_status(prof, n) == "ready", "status": mem_status(prof, n),
             "setup": {"pip_dependencies": [], "python_dependencies_declared": False, "external_dependencies": s["deps"], "required_env": list(s["env"].values()), "dependencies_installed": not s["deps"] or n in st["installed"]}}
            for n, s in MEMORY_PROVIDERS.items()]}

    @app.put("/api/memory/provider")
    async def memory_provider(body: MemProviderBody, profile: str | None = None):
        prof = profile_or_default(profile)
        if body.provider and body.provider not in MEMORY_PROVIDERS:
            raise HTTPException(400, f"Unknown memory provider '{body.provider}'")
        if body.provider and mem_status(prof, body.provider) != "ready":
            raise HTTPException(400, f"Memory provider '{body.provider}' is not ready ({mem_status(prof, body.provider)}). Configure it in the dashboard first.")
        if not drop_writes:
            mem(prof)["active"] = body.provider
        return {"ok": True, "active": body.provider}

    @app.post("/api/memory/reset")
    async def memory_reset(body: MemResetBody, profile: str | None = None):
        prof = profile_or_default(profile)
        app.state.memory_calls.append(("POST", "/api/memory/reset"))
        if body.target not in ("all", "memory", "user"):
            raise HTTPException(400, "target must be all, memory, or user")
        files = mem(prof)["files"]
        gone = [{"memory": "MEMORY.md", "user": "USER.md"}[k] for k in files if body.target in ("all", k) and files[k]]
        for k in files:
            if body.target in ("all", k) and not drop_writes:
                files[k] = 0
        return {"ok": True, "deleted": gone}

    @app.get("/api/memory/providers/{name}/config")
    async def memory_cfg(name: str, profile: str | None = None):
        prof = profile_or_default(profile)
        if name not in MEMORY_PROVIDERS:
            raise HTTPException(404, "Unknown memory provider")
        spec, cfg = MEMORY_PROVIDERS[name], mem(prof)["cfg"].setdefault(name, {})
        rows = []
        for f in spec["fields"]:
            secret = f["kind"] == "secret"
            is_set = (spec["env"].get(f["key"]) in prof["env"]) if secret else f["key"] in cfg or bool(f.get("default"))
            rows.append({**{k: f[k] for k in ("key", "label", "kind", "description", "required", "url", "options")}, "placeholder": "", "value": "" if secret else str(cfg.get(f["key"], f.get("default", ""))), "is_set": is_set,
                         "when": None, "minimum": None, "maximum": None, "step": None})
        return {"name": name, "label": name.title(), "fields": rows, "setup": {"pip_dependencies": [], "external_dependencies": spec["deps"], "dependencies_installed": not spec["deps"] or name in mem(prof)["installed"]}}

    @app.put("/api/memory/providers/{name}/config")
    async def memory_cfg_put(name: str, body: MemConfigBody, profile: str | None = None):
        prof = profile_or_default(profile)
        if name not in MEMORY_PROVIDERS:
            raise HTTPException(404, "Unknown memory provider")
        spec = MEMORY_PROVIDERS[name]
        if any(str(v).startswith("echo:") for v in body.values.values()):
            raise HTTPException(400, "Invalid value " + str(next(v for v in body.values.values() if str(v).startswith("echo:"))))
        for key, value in body.values.items():
            field = next((f for f in spec["fields"] if f["key"] == key), None)
            if field is None:
                raise HTTPException(400, f"Unknown field {key}")
            if field["kind"] == "secret":
                if str(value).strip() and not drop_writes:
                    prof["env"][spec["env"][key]] = str(value).strip()
            elif not drop_writes:
                mem(prof)["cfg"].setdefault(name, {})[key] = str(value)
        if mem_status(prof, name) != "ready":
            raise HTTPException(400, f"Memory provider '{name}' is not ready ({mem_status(prof, name)}). Configure it in the dashboard first.")
        if not drop_writes:
            mem(prof)["active"] = name
        return {"ok": True, "active": name}

    @app.post("/api/memory/providers/{name}/setup")
    async def memory_setup(name: str):
        app.state.memory_calls.append(("POST", f"/api/memory/providers/{name}/setup"))
        return {"ok": True, "provider": name, "results": [], "status": "no_declared_steps"}

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
