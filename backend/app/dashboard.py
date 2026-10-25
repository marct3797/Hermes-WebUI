"""Dashboard-Brücke: spricht das `hermes dashboard` einer Maschine an.

Die Agent-API (Port 9121) kennt weder SOUL.md noch Profil-Einstellungen. Das Dashboard (eigener Prozess,
standardmäßig 127.0.0.1) kann sie lesen und schreiben und verwaltet alle Profile seiner Maschine. Das BFF
ist sein einziger Client: der Browser sieht das Dashboard nie, der Token verlässt das BFF nicht.

SOUL.md legt fest, wie sich ein Agent verhält. Jede Änderung legt vorher einen Stand im Verlauf ab, sodass
sich alles zurückholen lässt. Der Verlauf wird nie gekürzt oder gelöscht, nur die Anzeige ist begrenzt.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from pathlib import Path
from typing import Any

import httpx

from .adapters import UpstreamError
from .quota import PLUGIN_MISSING
from .cache import TtlCache
from .registry import DashboardCfg

SOUL_MAX_CHARS = 100_000  # SOUL.md geht in den Systemprompt; mehr ist nie sinnvoll
DESCRIPTION_MAX_CHARS = 500
HISTORY_SHOWN = 30
VERSION_RE = re.compile(r"^\d{8}T\d{12}$")


def digest(text: str) -> str:
    """Kurzer Fingerabdruck eines Textes. Damit merkt das BFF, ob SOUL.md sich seit dem Laden geändert hat."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


LOOPBACK_HINT = ("Das Dashboard auf 127.0.0.1 des Hosts lassen und per Tunnel (ssh -L) auf 127.0.0.1 dieses Rechners führen, "
                 "dann diese Adresse in hosts.json eintragen (README, „Dashboard auf einem anderen Rechner“).")


def _submitted_strings(body: Any, depth: int = 0) -> set[str]:
    """Alle Texte eines Anfragekörpers (auch verschachtelt), die in einer Fehlermeldung nichts zu suchen haben: Hermes nennt manchmal den abgelehnten Wert."""
    if depth > 4:
        return set()
    if isinstance(body, str):
        return {body} if len(body) >= 4 else set()
    if isinstance(body, dict):
        return {s for v in body.values() for s in _submitted_strings(v, depth + 1)}
    if isinstance(body, list):
        return {s for v in body for s in _submitted_strings(v, depth + 1)}
    return set()

class CacheCfg:
    """TTLs in Sekunden (per Umgebung überschreibbar, siehe Settings). Standard: Modelle 5 min, Profile und Env 20 s."""

    def __init__(self, cache: TtlCache, models_ttl: float = 300.0, state_ttl: float = 20.0, stale_max: float = 600.0):
        self.cache, self.models_ttl, self.state_ttl, self.stale_max = cache, models_ttl, state_ttl, stale_max


def _route_unknown(res: httpx.Response) -> bool:
    """Hermes beantwortet eine unbekannte API-Route mit „No such API endpoint“ (seit v2026.7.20 gemessen); fehlende Ressourcen haben eigene Texte."""
    try:
        d = res.json().get("detail")
    except (ValueError, AttributeError):
        return False
    return isinstance(d, str) and d.startswith("No such API endpoint")


class DashboardClient:
    def __init__(self, cfg: DashboardCfg, http: httpx.AsyncClient, caching: CacheCfg | None = None):
        self._cfg, self._http, self._caching = cfg, http, caching
        self.stale = False  # wurde in diesem Client mindestens eine Antwort aus dem alten Stand bedient?

    async def _cached(self, kind: str, name: str, ttl_of: str, load):
        c = self._caching
        if c is None:
            return await load()
        value, stale = await c.cache.get((self._cfg.base_url, kind, name), getattr(c, ttl_of), load, stale_max=c.stale_max)
        self.stale = self.stale or stale
        return value

    def _changed(self) -> None:
        """Nach jedem schreibenden Aufruf: alles zu diesem Dashboard verwerfen (Profile, Env und Modelle hängen zusammen)."""
        if self._caching:
            base = self._cfg.base_url
            self._caching.cache.invalidate(lambda k: k[0] == base)

    async def _call(self, method: str, path: str, *, json_body: Any = None, params: dict[str, str] | None = None, missing: str | None = None,
                    explain: bool = False) -> Any:
        headers = {"X-Hermes-Session-Token": self._cfg.token} if self._cfg.token else {}
        try:
            res = await self._http.request(method, f"{self._cfg.base_url}{path}", json=json_body, params=params, headers=headers)
        except httpx.TimeoutException as e:
            raise UpstreamError(504, "Das Dashboard antwortet nicht") from e
        except httpx.HTTPError as e:
            raise UpstreamError(503, "Das Dashboard ist nicht erreichbar") from e
        if 300 <= res.status_code < 400:
            raise UpstreamError(502, f"Das Dashboard verlangt eine eigene Anmeldung (es lauscht nicht auf Loopback). {LOOPBACK_HINT}")
        if res.status_code in (401, 403):
            raise UpstreamError(502, f"Das Dashboard lehnt den Zugang ab: Token prüfen. Lauscht es nicht auf Loopback, verlangt Hermes ab 0.22 eine eigene Anmeldung. {LOOPBACK_HINT}")
        if res.status_code == 400 and "Invalid Host header" in res.text[:300]:
            raise UpstreamError(502, f"Das Dashboard lehnt den Rechnernamen im Host-Header ab (Hermes ab 0.22 erlaubt nur 127.0.0.1 und localhost). {LOOPBACK_HINT}")
        if res.status_code == 404:
            if _route_unknown(res) and not path.startswith("/api/plugins/"):  # Plugin-Routen behalten ihre eigene Meldung („Plugin nicht installiert“)
                raise UpstreamError(501, f"Diese Hermes-Version kennt {path} nicht. Hermes aktualisieren (Mindestversion: docs/compatibility.md).")
            raise UpstreamError(404, missing or "Das Dashboard kennt dieses Profil nicht")
        if res.status_code >= 400:
            why = ""
            if explain:  # Anmeldungen scheitern aus Gründen, die der Person helfen (Netz, abgelaufen, abgelehnt)
                try:
                    d = res.json().get("detail")
                    if isinstance(d, str):
                        for secret in sorted(_submitted_strings(json_body), key=len, reverse=True):
                            d = d.replace(secret, "[REDACTED]")
                    why = f": {d[:200]}" if isinstance(d, str) else ""
                except (ValueError, AttributeError):
                    pass
            raise UpstreamError(502, f"Das Dashboard meldet Fehler {res.status_code}{why}")
        try:
            return res.json()
        except ValueError as e:
            raise UpstreamError(502, "Das Dashboard antwortet nicht im erwarteten Format") from e

    async def profiles(self) -> list[dict[str, Any]]:
        body = await self._cached("profiles", "", "state_ttl", lambda: self._call("GET", "/api/profiles"))
        items = body.get("profiles") if isinstance(body, dict) else None
        if not isinstance(items, list):
            raise UpstreamError(502, "Das Dashboard liefert keine Profilliste")
        return [p for p in items if isinstance(p, dict)]

    async def profile(self, name: str) -> dict[str, Any] | None:
        return next((p for p in await self.profiles() if p.get("name") == name), None)

    async def soul(self, name: str) -> dict[str, Any]:
        body = await self._call("GET", f"/api/profiles/{name}/soul")
        if not isinstance(body, dict) or not isinstance(body.get("content"), str):
            raise UpstreamError(502, "Das Dashboard liefert SOUL.md in unbekannter Form")
        return {"content": body["content"], "exists": bool(body.get("exists", True))}

    async def set_soul(self, name: str, content: str) -> None:
        await self._call("PUT", f"/api/profiles/{name}/soul", json_body={"content": content})

    async def set_description(self, name: str, text: str) -> None:
        await self._call("PUT", f"/api/profiles/{name}/description", json_body={"description": text})
        self._changed()

    async def set_model(self, name: str, provider: str, model: str) -> None:
        await self._call("PUT", f"/api/profiles/{name}/model", json_body={"provider": provider, "model": model})
        self._changed()

    # Anbieter, Keys und Nutzung eines Profils: das Profil steht als Abfrageparameter (`?profile=`), nicht im Pfad.
    async def env(self, name: str) -> Any:
        return await self._cached("env", name, "state_ttl", lambda: self._call("GET", "/api/env", params={"profile": name}))

    async def oauth_providers(self, name: str) -> Any:
        return await self._call("GET", "/api/providers/oauth", params={"profile": name})

    async def model_analytics(self, name: str, days: int) -> Any:
        return await self._call("GET", "/api/analytics/models", params={"profile": name, "days": str(days)})

    async def quota(self, name: str, refresh: bool) -> Any:
        """Restkontingente über das Dashboard-Plugin `ai-usage-tracker`. 404 heißt: Plugin auf diesem Dashboard nicht installiert."""
        return await self._call("GET", "/api/plugins/ai-usage-tracker/usage", params={"profile": name, "refresh": "1" if refresh else "0"}, missing=PLUGIN_MISSING)

    # Skills und Werkzeuge eines Profils: Ersatzquelle, wenn die Agent-API sie nicht auflisten kann.
    async def skills(self, name: str) -> list[dict[str, Any]]:
        return self._rows(await self._call("GET", "/api/skills", params={"profile": name}), "Skills")

    async def toolsets(self, name: str) -> list[dict[str, Any]]:
        return self._rows(await self._call("GET", "/api/tools/toolsets", params={"profile": name}), "Werkzeuge")

    @staticmethod
    def _rows(body: Any, what: str) -> list[dict[str, Any]]:
        rows = body.get("data") if isinstance(body, dict) else body
        if not isinstance(rows, list):
            raise UpstreamError(502, f"Das Dashboard liefert {what} in unbekannter Form")
        return [r for r in rows if isinstance(r, dict)]

    async def request(self, method: str, path: str, *, body: Any = None, params: dict[str, str] | None = None,
                      missing: str | None = None) -> Any:
        """Öffentlicher Durchgriff auf eine Dashboard-Route (Pakete bauen darauf ihre festen, validierten Routen).
        Fehlertexte des Dashboards werden mitgegeben, damit Eingabefehler (z. B. ungültiger Skill-Name) sichtbar werden."""
        return await self._call(method, path, json_body=body, params=params, missing=missing or "Nicht gefunden: das Dashboard kennt diese Ressource nicht", explain=True)

    # Nur lesende Host-Daten (Kanban, Logs, MCP, Plugins, Suche): Ersatzquelle, wenn der Host-Dienst sie nicht liefern kann.
    async def kanban_board(self, name: str) -> Any:
        return await self._call("GET", "/api/plugins/kanban/board", params={"profile": name}, missing="Kanban ist auf diesem Dashboard nicht verfügbar")

    async def logs(self, name: str, lines: int) -> Any:
        return await self._call("GET", "/api/logs", params={"profile": name, "lines": str(lines)})

    async def mcp_servers(self, name: str) -> Any:
        return await self._call("GET", "/api/mcp/servers", params={"profile": name})

    async def plugin_hub(self, name: str) -> Any:
        return await self._call("GET", "/api/dashboard/plugins/hub", params={"profile": name})

    async def session_search(self, query: str) -> Any:
        return await self._call("GET", "/api/sessions/search", params={"q": query})

    # Modelle und Anmeldungen: welche Anbieter ein Profil nutzen kann und wie man sich bei ihnen anmeldet.
    async def model_options(self, name: str) -> Any:
        return await self._cached("models", name, "models_ttl", lambda: self._call("GET", "/api/model/options", params={"profile": name}))

    async def oauth_start(self, name: str, provider: str) -> Any:
        return await self._call("POST", f"/api/providers/oauth/{provider}/start", params={"profile": name}, missing="Dieser Anbieter kennt keine Anmeldung über das Dashboard", explain=True)

    async def oauth_poll(self, name: str, provider: str, session: str) -> Any:
        body = await self._call("GET", f"/api/providers/oauth/{provider}/poll/{session}", params={"profile": name}, missing="Die Anmeldung ist abgelaufen", explain=True)
        if isinstance(body, dict) and body.get("status") not in (None, "pending"):
            self._changed()  # Anmeldung abgeschlossen (oder gescheitert): Env und Modellliste können sich geändert haben
        return body

    async def oauth_submit(self, name: str, provider: str, session: str, code: str) -> Any:
        body = await self._call("POST", f"/api/providers/oauth/{provider}/submit", params={"profile": name}, json_body={"session_id": session, "code": code}, missing="Die Anmeldung ist abgelaufen", explain=True)
        self._changed()
        return body

    async def oauth_cancel(self, session: str) -> None:
        await self._call("DELETE", f"/api/providers/oauth/sessions/{session}", missing="Die Anmeldung ist abgelaufen")

    async def oauth_disconnect(self, name: str, provider: str) -> Any:
        body = await self._call("DELETE", f"/api/providers/oauth/{provider}", params={"profile": name}, missing="Dieser Anbieter ist nicht angemeldet")
        self._changed()
        return body

    async def validate_key(self, var: str, value: str) -> Any:
        return await self._call("POST", "/api/providers/validate", json_body={"key": var, "value": value})

    async def set_key(self, name: str, var: str, value: str) -> None:
        await self._call("PUT", "/api/env", params={"profile": name}, json_body={"key": var, "value": value}, explain=True)
        self._changed()


class SoulConflict(Exception):
    """SOUL.md hat sich seit dem Laden geändert (zweiter Editor, der Agent selbst, ein Skript)."""

    def __init__(self, current: str):
        self.current = current
        super().__init__("SOUL.md wurde inzwischen geändert")


class SoulHistory:
    """Verlauf je Agent als Dateien: <Ordner>/<host>__<runtime>__<agent>/<Zeitstempel>.json, nur für den Dienstnutzer lesbar."""

    def __init__(self, root: Path):
        self._root = root

    def _dir(self, host: str, runtime: str, agent: str) -> Path:
        return self._root / f"{host}__{runtime}__{agent}"  # alle drei Teile sind vorab auf harmlose Zeichen geprüft

    def _versions(self, d: Path) -> list[Path]:
        try:
            return sorted((p for p in d.iterdir() if p.suffix == ".json" and VERSION_RE.match(p.stem)), reverse=True)
        except OSError:
            return []

    def add(self, host: str, runtime: str, agent: str, content: str, reason: str) -> str | None:
        """Legt einen Stand ab. Ist er identisch mit dem neuesten, passiert nichts. Gibt die Kennung zurück."""
        d = self._dir(host, runtime, agent)
        newest = self._versions(d)[:1]
        if newest:
            try:
                if json.loads(newest[0].read_text(encoding="utf-8")).get("content") == content:
                    return newest[0].stem
            except (OSError, ValueError):
                pass
        now = time.time()
        vid = time.strftime("%Y%m%dT%H%M%S", time.gmtime(now)) + f"{int((now % 1) * 1_000_000):06d}"
        entry = {"id": vid, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)), "reason": reason, "content": content}
        d.mkdir(parents=True, exist_ok=True, mode=0o700)
        tmp = d / f".{vid}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(entry, f, ensure_ascii=False)
        os.replace(tmp, d / f"{vid}.json")
        return vid

    def entries(self, host: str, runtime: str, agent: str, limit: int = HISTORY_SHOWN) -> list[dict[str, Any]]:
        out = []
        for p in self._versions(self._dir(host, runtime, agent))[:limit]:
            try:
                e = json.loads(p.read_text(encoding="utf-8"))
                out.append({"id": e["id"], "at": e["at"], "reason": e.get("reason", ""), "chars": len(e["content"])})
            except (OSError, ValueError, KeyError, TypeError):
                continue  # kaputte Datei überspringen statt den Verlauf zu blockieren
        return out

    def get(self, host: str, runtime: str, agent: str, vid: str) -> dict[str, Any] | None:
        if not VERSION_RE.match(vid):
            return None
        try:
            e = json.loads((self._dir(host, runtime, agent) / f"{vid}.json").read_text(encoding="utf-8"))
            return {"id": e["id"], "at": e["at"], "reason": e.get("reason", ""), "content": e["content"]}
        except (OSError, ValueError, KeyError):
            return None


async def save_soul(
    client: DashboardClient, history: SoulHistory, host: str, runtime: str, agent: str,
    content: str, *, base: str | None, reason: str,
) -> dict[str, Any]:
    """Speichert SOUL.md: prüft den Ausgangsstand, sichert den alten Text, schreibt, liest zur Kontrolle zurück."""
    current = await client.soul(agent)
    if base is not None and base != digest(current["content"]):
        raise SoulConflict(current["content"])
    if content == current["content"]:
        return {"changed": False, "hash": digest(content)}
    if current["content"]:
        history.add(host, runtime, agent, current["content"], reason)
    await client.set_soul(agent, content)
    if (await client.soul(agent))["content"] != content:
        raise UpstreamError(502, "Das Dashboard hat SOUL.md nicht wie gesendet gespeichert")
    return {"changed": True, "hash": digest(content)}
