"""Marktplatz: eigene Quellen (marketplaces.json), SSRF-geschützter Abruf von MCP-Registries und deren Umsetzung in Einträge.

Die Datei gehört zur WebUI-Config (Muster `ui.py`): atomar geschrieben, Rechte 0600, höchstens 50 Quellen.
"""
from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import os
import re
import socket
import threading
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlsplit

import httpx

from .extensions import GIT_SLUG_RE, GIT_URL_RE, safe_url, trim

KINDS = ("github", "well-known", "url", "mcp-registry", "plugin-git")
MAX_SOURCES = 50
FETCH_TIMEOUT_S = 8.0
FETCH_LIMIT = 1024 * 1024
MAX_HOPS = 3
OFFICIAL_REGISTRY = "https://registry.modelcontextprotocol.io"
GITHUB_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}(/[A-Za-z0-9_./-]{1,200})?$")

Resolver = Callable[[str, int], Awaitable[list[str]]]


class SourceError(ValueError):
    """Quelle unzulässig oder nicht abrufbar; die Meldung ist für Menschen gedacht."""

    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


async def system_resolver(host: str, port: int) -> list[str]:
    infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return sorted({str(i[4][0]) for i in infos})


def is_public(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip.split("%")[0])
    except ValueError:
        return False
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return addr.is_global and not addr.is_multicast


def syntax_ok(url: str) -> Any:
    try:
        p = urlsplit(url)
        port = p.port
    except ValueError:
        raise SourceError("Ungültige Adresse") from None
    if p.scheme != "https" or not p.hostname:
        raise SourceError("Nur https-Adressen sind erlaubt")
    if p.username or p.password or p.fragment:
        raise SourceError("Die Adresse darf keine Zugangsdaten und kein Fragment enthalten")
    if port not in (None, 443):
        raise SourceError("Nur der Standard-Port 443 ist erlaubt")
    return p


async def check_public_url(url: str, resolver: Resolver) -> str:
    """Wirft SourceError, wenn die Adresse nicht https ist oder auf eine nicht öffentliche Adresse zeigt. Gibt den Host zurück.

    shortcut: Prüfung und Verbindung lösen den Namen getrennt auf (DNS-Rebinding bleibt im Zeitfenster möglich), bei Bedarf Verbindung an die geprüfte IP binden.
    """
    host = syntax_ok(url).hostname or ""
    try:
        ips = [str(ipaddress.ip_address(host))]
    except ValueError:
        try:
            ips = await resolver(host, 443)
        except OSError:
            raise SourceError("Der Hostname lässt sich nicht auflösen", 502) from None
    if not ips or not all(is_public(i) for i in ips):
        raise SourceError("Die Adresse zeigt auf ein nicht öffentliches Netz und wird nicht abgerufen")
    return host


async def fetch_json(http: httpx.AsyncClient, url: str, resolver: Resolver, params: dict[str, str] | None = None) -> Any:
    """GET mit 8 s Zeitlimit, höchstens 1 MiB; Weiterleitungen nur innerhalb desselben Hosts (jeder Schritt wird neu geprüft)."""
    origin = await check_public_url(url, resolver)
    current = url
    for _ in range(MAX_HOPS + 1):
        try:
            async with http.stream("GET", current, params=params, headers={"Accept": "application/json"}, timeout=FETCH_TIMEOUT_S,
                                   follow_redirects=False) as r:
                if r.status_code in (301, 302, 303, 307, 308):
                    nxt = urljoin(current, r.headers.get("location", ""))
                    if urlsplit(nxt).hostname != origin:
                        raise SourceError("Weiterleitung auf einen anderen Host wird nicht verfolgt")
                    await check_public_url(nxt, resolver)
                    current, params = nxt, None
                    continue
                if r.status_code != 200:
                    raise SourceError(f"Die Quelle antwortet mit Status {r.status_code}", 502)
                chunks, size = [], 0
                async for chunk in r.aiter_bytes():
                    size += len(chunk)
                    if size > FETCH_LIMIT:
                        raise SourceError("Die Antwort der Quelle ist größer als 1 MiB", 502)
                    chunks.append(chunk)
        except httpx.TimeoutException:
            raise SourceError("Die Quelle antwortet nicht innerhalb von 8 Sekunden", 504) from None
        except httpx.HTTPError as e:
            raise SourceError(f"Die Quelle ist nicht erreichbar ({type(e).__name__})", 502) from None
        try:
            return json.loads(b"".join(chunks))
        except ValueError:
            raise SourceError("Die Quelle liefert kein gültiges JSON", 502) from None
    raise SourceError("Zu viele Weiterleitungen", 502)


# --- MCP-Registry -> Einträge ---------------------------------------------------------------------
def _slug(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9_-]+", "-", name.rsplit("/", 1)[-1]).strip("-_")
    return s[:64] or "server"


def registry_entry(raw: Any) -> dict[str, Any] | None:
    srv = raw.get("server") if isinstance(raw, dict) and isinstance(raw.get("server"), dict) else raw
    if not isinstance(srv, dict) or not isinstance(srv.get("name"), str):
        return None
    name, version = trim(srv["name"], 200), trim(srv.get("version"), 40)
    entry: dict[str, Any] = {"name": name, "slug": _slug(name), "description": trim(srv.get("description"), 500), "version": version,
                             "repo": None, "installable": False, "transport": None, "url": None, "command": None, "args": [], "env": []}
    repo = srv.get("repository")
    if isinstance(repo, dict):
        entry["repo"] = safe_url(repo.get("url"))
    for pkg in (p for p in srv.get("packages") or [] if isinstance(p, dict)):
        env = [{"name": trim(e.get("name"), 64), "description": trim(e.get("description"), 200), "required": e.get("isRequired") is True,
                "secret": e.get("isSecret") is True} for e in pkg.get("environmentVariables") or [] if isinstance(e, dict)]
        ident, kind = trim(pkg.get("identifier"), 200), pkg.get("registryType")
        if kind == "npm" and ident:
            entry.update(transport="stdio", command="npx", args=["-y", f"{ident}@{version}" if version else ident], env=env, installable=True)
        elif kind == "pypi" and ident:
            entry.update(transport="stdio", command="uvx", args=[ident], env=env, installable=True)
        if entry["installable"]:
            break
    if not entry["installable"]:
        for r in (r for r in srv.get("remotes") or [] if isinstance(r, dict) and r.get("type") in ("streamable-http", "sse", "http")):
            url = safe_url(r.get("url"))
            if url:
                entry.update(transport="http", url=url, installable=True)
                break
    return entry


def registry_entries(data: Any) -> tuple[list[dict[str, Any]], str | None]:
    servers = data.get("servers") if isinstance(data, dict) else None
    if not isinstance(servers, list):
        raise SourceError("Die Quelle liefert keine Serverliste", 502)
    seen: set[str] = set()
    out = []
    for raw in servers[:100]:
        e = registry_entry(raw)
        if e and e["name"] not in seen:
            seen.add(e["name"])
            out.append(e)
    meta = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
    cursor = meta.get("nextCursor")
    return out, cursor if isinstance(cursor, str) and len(cursor) <= 200 else None


# --- Quellenliste ---------------------------------------------------------------------------------
def validate_target(kind: str, target: str) -> str:
    target = target.strip()
    if kind not in KINDS:
        raise SourceError("Unbekannte Art der Quelle")
    if not target or len(target) > 300 or not target.isprintable():
        raise SourceError("Das Ziel fehlt oder ist zu lang")
    if kind == "github":
        if not GITHUB_RE.match(target) or ".." in target:
            raise SourceError("Erwartet owner/repo oder owner/repo/unterordner")
    elif kind == "plugin-git":
        if not (GIT_SLUG_RE.match(target) or GIT_URL_RE.match(target)) or ".." in target:
            raise SourceError("Erwartet owner/repo oder eine https-Git-Adresse")
    else:
        p = syntax_ok(target)
        if p.query:
            raise SourceError("Die Adresse darf keine Query enthalten")
        if kind == "url" and not p.path.lower().endswith(".md"):
            raise SourceError("Eine Direkt-URL muss auf eine .md-Datei zeigen")
    return target


class Marketplaces:
    """Liest und schreibt marketplaces.json; Fehler beim Schreiben werden als SourceError mit Status gemeldet."""

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()

    def list(self) -> list[dict[str, str]]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        items = raw.get("sources") if isinstance(raw, dict) else None
        out = []
        for e in items if isinstance(items, list) else []:
            if isinstance(e, dict) and all(isinstance(e.get(k), str) for k in ("id", "label", "kind", "target")) and e["kind"] in KINDS:
                out.append({k: e[k] for k in ("id", "label", "kind", "target")})
        return out[:MAX_SOURCES]

    def _write(self, items: list[dict[str, str]]) -> None:
        tmp = self.path.with_name(f".{self.path.name}.{os.getpid()}.tmp")
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(json.dumps({"sources": items}, ensure_ascii=False, indent=2) + "\n")
            os.replace(tmp, self.path)
        except OSError as e:
            tmp.unlink(missing_ok=True)
            raise SourceError(f"{self.path.name} lässt sich nicht schreiben ({type(e).__name__})", 503) from e

    def add(self, label: str, kind: str, target: str) -> dict[str, str]:
        label = label.strip()
        if not 1 <= len(label) <= 60 or not label.isprintable():
            raise SourceError("Die Beschriftung braucht 1 bis 60 druckbare Zeichen")
        target = validate_target(kind, target)
        sid = f"{kind}-{hashlib.sha1(f'{kind} {target}'.encode()).hexdigest()[:8]}"
        with self._lock:
            items = self.list()
            if any(i["id"] == sid for i in items):
                raise SourceError("Diese Quelle gibt es schon", 409)
            if len(items) >= MAX_SOURCES:
                raise SourceError(f"Es sind höchstens {MAX_SOURCES} eigene Quellen möglich", 409)
            entry = {"id": sid, "label": label, "kind": kind, "target": target}
            self._write([*items, entry])
        return entry

    def remove(self, sid: str) -> dict[str, str]:
        with self._lock:
            items = self.list()
            hit = next((i for i in items if i["id"] == sid), None)
            if hit is None:
                raise SourceError("Quelle nicht gefunden", 404)
            self._write([i for i in items if i["id"] != sid])
        return hit
