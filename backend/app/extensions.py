"""Hilfen für die Verwaltung von Skills, MCP-Servern und Plugins: Prüfung der Eingaben und Kürzen der Dashboard-Antworten.

Geheimnisse (Env-Werte, Tokens, Query-Teile von URLs, lokale Pfade) verlassen das BFF nie: Antworten zeigen nur Namen.
"""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator

SKILL_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")  # neue Skills
SKILL_OLD_RE = r"^[a-z0-9][a-z0-9._-]{0,63}$"  # vorhandene (Hermes erlaubt Punkte)
CATEGORY_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
MCP_NAME_RE = r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
ENV_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
PLUGIN_NAME_RE = r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$"
GIT_SLUG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$")
GIT_URL_RE = re.compile(r"^https://[A-Za-z0-9.-]{1,253}(:\d{1,5})?/[A-Za-z0-9_./~-]{1,200}$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
IDENT_URL_RE = re.compile(r"^(well-known:)?https://[^\s@#?]{1,480}(#[A-Za-z0-9._-]{1,64})?$")
IDENT_SLUG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._~+-]{0,99}(/[A-Za-z0-9._~+-]{1,100}){1,6}$")
MAX_SKILL_BYTES = 200 * 1024


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


def valid_identifier(value: str) -> str:
    """Hub-Kennung: `quelle/pfad`, `owner/repo/pfad`, Direkt-URL (`https://…md`) oder `well-known:https://…`."""
    if IDENT_URL_RE.match(value) or (IDENT_SLUG_RE.match(value) and ".." not in value):
        return value
    raise ValueError("Ungültige Kennung (erwartet: quelle/pfad, owner/repo/pfad oder eine https-Adresse)")


def valid_git_target(value: str) -> str:
    if (GIT_SLUG_RE.match(value) or GIT_URL_RE.match(value)) and ".." not in value:
        return value
    raise ValueError("Ungültige Plugin-Kennung (erwartet: owner/repo oder https-Git-Adresse)")


def check_skill_content(name: str, content: str) -> None:
    """Frontmatter mit `name` und `description` verlangen; Fehler sind für Menschen lesbar."""
    if len(content.encode()) > MAX_SKILL_BYTES:
        raise ValueError("Der Inhalt ist größer als 200 KB")
    m = re.match(r"\A---\r?\n(.*?)\r?\n---\s*(\r?\n|\Z)", content, re.S)
    if not m:
        raise ValueError("Am Anfang fehlt der Frontmatter-Block (--- … ---) mit name und description")
    head = m.group(1)
    found = re.search(r"^name:\s*['\"]?([^'\"\r\n]+?)['\"]?\s*$", head, re.M)
    if not found:
        raise ValueError("Im Frontmatter fehlt die Zeile name:")
    if found.group(1) != name:
        raise ValueError(f"Im Frontmatter steht name: {found.group(1)}, erwartet wird {name}")
    desc = re.search(r"^description:[ \t]*(.*)$(\r?\n[ \t]+\S.*)?", head, re.M)
    if not desc or not ((desc.group(1) or "").strip() or desc.group(2)):
        raise ValueError("Im Frontmatter fehlt die description: oder sie ist leer")


class SkillSave(Strict):
    content: str = Field(max_length=MAX_SKILL_BYTES)


class SkillNew(Strict):
    name: str = Field(pattern=SKILL_RE.pattern)
    category: str | None = Field(None, pattern=CATEGORY_RE.pattern)
    content: str = Field(max_length=MAX_SKILL_BYTES)

    @field_validator("content")
    @classmethod
    def frontmatter(cls, v, info):
        if "name" in info.data:
            check_skill_content(info.data["name"], v)
        return v


class Toggle(Strict):
    enabled: bool


def safe_url(url: Any) -> str | None:
    """Adresse ohne Zugangsdaten, Query und Fragment."""
    if not isinstance(url, str) or not url:
        return None
    try:
        p = urlsplit(url)
    except ValueError:
        return None
    if p.scheme not in ("http", "https") or not p.hostname:
        return None
    host = f"[{p.hostname}]" if ":" in p.hostname else p.hostname
    return f"{p.scheme}://{host}{':' + str(p.port) if p.port else ''}{p.path}"


SECRET_FLAG = re.compile(r"(token|key|secret|pass|auth|credential)", re.I)


def safe_args(args: list[Any]) -> list[str]:
    """Argumente wie `--api-key XYZ` oder `--token=XYZ` zeigen den Wert nicht."""
    out, hide = [], False
    for a in map(str, args[:50]):
        a = a[:300]
        if hide:
            out.append("«gesetzt»")
            hide = False
        elif a.startswith("-") and SECRET_FLAG.search(a.split("=")[0]):
            if "=" in a:
                a = a.split("=")[0] + "=«gesetzt»"
            else:
                hide = True
            out.append(a)
        else:
            out.append(a)
    return out


def _env_ok(v: dict[str, str]) -> dict[str, str]:
    for k, val in v.items():
        if not ENV_RE.match(k) or len(val) > 4096 or "\x00" in val:
            raise ValueError(f"Ungültige Env-Variable: {k[:64]}")
    return v


class McpNew(Strict):
    name: str = Field(pattern=MCP_NAME_RE)
    transport: str = Field(pattern=r"^(stdio|http)$")
    command: str | None = Field(None, min_length=1, max_length=300)
    args: list[str] = Field(default_factory=list, max_length=50)
    env: dict[str, str] = Field(default_factory=dict, max_length=50)
    url: str | None = Field(None, max_length=500)
    auth: str = Field("none", pattern=r"^(none|header|oauth)$")
    bearer_token: str | None = Field(None, min_length=1, max_length=4096)

    @field_validator("args")
    @classmethod
    def args_ok(cls, v):
        if any(len(a) > 500 or "\x00" in a for a in v):
            raise ValueError("Argument zu lang oder ungültig")
        return v

    @field_validator("env")
    @classmethod
    def env_ok(cls, v):
        return _env_ok(v)

    def model_post_init(self, _ctx) -> None:
        if self.transport == "stdio":
            if not self.command or self.url:
                raise ValueError("stdio braucht einen Befehl und keine URL")
            if self.auth != "none" or self.bearer_token:
                raise ValueError("Anmeldung gibt es nur bei http")
        else:
            if not self.url or self.command or self.args or self.env:
                raise ValueError("http braucht eine URL, aber keinen Befehl, keine Argumente und keine Env-Variablen")
            p = urlsplit(self.url)
            if p.scheme not in ("http", "https") or not p.hostname or p.username or p.password:
                raise ValueError("Die URL muss mit http:// oder https:// beginnen und darf keine Zugangsdaten enthalten")
            if (self.auth == "header") != bool(self.bearer_token):
                raise ValueError("Bearer-Token und Anmeldung per Header gehören zusammen")

    def to_dashboard(self) -> dict[str, Any]:
        body: dict[str, Any] = {"name": self.name, "auth": self.auth}
        if self.transport == "stdio":
            body.update(command=self.command, args=self.args, env=self.env)
        else:
            body["url"] = self.url
            if self.bearer_token:
                body["bearer_token"] = self.bearer_token
        return body


class CatalogInstall(Strict):
    name: str = Field(pattern=MCP_NAME_RE)
    env: dict[str, str] = Field(default_factory=dict, max_length=50)
    enable: bool = True

    @field_validator("env")
    @classmethod
    def env_ok(cls, v):
        return _env_ok(v)


class PluginInstall(Strict):
    identifier: str = Field("", max_length=300)
    catalog_name: str | None = Field(None, pattern=PLUGIN_NAME_RE)
    ref: str | None = None
    force: bool = False
    enable: bool = True

    @field_validator("identifier")
    @classmethod
    def ident(cls, v):
        return valid_git_target(v) if v else v

    @field_validator("ref")
    @classmethod
    def sha(cls, v):
        if v is not None and not SHA_RE.match(v):
            raise ValueError("ref muss ein voller Commit-Hash (40 Hex-Zeichen) sein")
        return v

    def model_post_init(self, _ctx) -> None:
        if bool(self.identifier) == bool(self.catalog_name):
            raise ValueError("Entweder eine Kennung (owner/repo) oder einen Katalognamen angeben")


class PluginUpdate(Strict):
    accept_capabilities: bool = False


def trim(value: Any, limit: int) -> str:
    return value[:limit] if isinstance(value, str) else ""


def skill_view(s: dict[str, Any]) -> dict[str, Any]:
    return {"name": trim(s.get("name"), 100), "description": trim(s.get("description"), 400), "category": trim(s.get("category"), 64) or None,
            "enabled": s.get("enabled") is not False, "usage": s.get("usage") if isinstance(s.get("usage"), int) else 0,
            "provenance": trim(s.get("provenance"), 16) or "agent"}


def mcp_view(s: dict[str, Any]) -> dict[str, Any]:
    tools = s.get("tools")
    env = s.get("env") if isinstance(s.get("env"), dict) else {}
    return {"name": trim(s.get("name"), 100), "transport": s.get("transport") if s.get("transport") in ("stdio", "http") else "unknown",
            "url": safe_url(s.get("url")), "command": trim(s.get("command"), 300) or None,
            "args": safe_args(s["args"]) if isinstance(s.get("args"), list) else [],
            "env_names": sorted(str(k)[:64] for k in env), "auth": trim(s.get("auth"), 16) or None,
            "enabled": s.get("enabled") is not False, "tool_count": len(tools) if isinstance(tools, list) else None,
            "source": "plugin" if s.get("source") == "plugin" else "config", "plugin": trim(s.get("plugin"), 100) or None}


def mcp_test_view(r: Any) -> dict[str, Any]:
    r = r if isinstance(r, dict) else {}
    tools = [{"name": trim(t.get("name"), 100), "description": trim(t.get("description"), 300)} for t in (r.get("tools") or [])[:200] if isinstance(t, dict)]
    return {"ok": r.get("ok") is True, "error": trim(r.get("error"), 500) or None, "tools": tools,
            "prompts": r.get("prompts") if isinstance(r.get("prompts"), int) else 0,
            "resources": r.get("resources") if isinstance(r.get("resources"), int) else 0}


def mcp_catalog_view(e: dict[str, Any]) -> dict[str, Any]:
    env = [{"name": trim(x.get("name"), 64), "prompt": trim(x.get("prompt"), 200), "required": x.get("required") is not False}
           for x in (e.get("required_env") or []) if isinstance(x, dict)]
    return {"name": trim(e.get("name"), 100), "description": trim(e.get("description"), 400), "transport": e.get("transport"),
            "auth_type": trim(e.get("auth_type"), 16) or "none", "required_env": env, "command": trim(e.get("command"), 300) or None,
            "args": safe_args(e["args"]) if isinstance(e.get("args"), list) else [], "url": safe_url(e.get("url")),
            "source": safe_url(e.get("source")), "needs_install": e.get("needs_install") is True,
            "post_install": trim(e.get("post_install"), 600), "installed": e.get("installed") is True, "enabled": e.get("enabled") is True}


def plugin_view(p: dict[str, Any]) -> dict[str, Any]:
    return {"name": trim(p.get("name"), 128), "version": trim(p.get("version"), 40), "description": trim(p.get("description"), 500),
            "source": trim(p.get("source"), 24), "runtime_status": trim(p.get("runtime_status"), 24) or None,
            "can_remove": p.get("can_remove") is True, "can_update_git": p.get("can_update_git") is True,
            "auth_required": p.get("auth_required") is True, "auth_command": trim(p.get("auth_command"), 200)}


def plugin_catalog_view(e: dict[str, Any]) -> dict[str, Any]:
    caps = e.get("capabilities") if isinstance(e.get("capabilities"), dict) else {}
    return {"name": trim(e.get("name"), 128), "description": trim(e.get("description"), 500), "repo": safe_url(e.get("repo")),
            "maintainer": trim(e.get("maintainer"), 100), "tier": trim(e.get("tier"), 24), "category": trim(e.get("category"), 48) or None,
            "version": trim(e.get("version"), 40), "installed": e.get("installed") is True, "update_available": e.get("update_available") is True,
            "runtime_status": trim(e.get("runtime_status"), 24) or None,
            "requires_env": [trim(x, 64) for x in (caps.get("requires_env") or [])[:20]]}
