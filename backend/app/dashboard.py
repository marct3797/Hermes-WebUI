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
from .registry import DashboardCfg

SOUL_MAX_CHARS = 100_000  # SOUL.md geht in den Systemprompt; mehr ist nie sinnvoll
DESCRIPTION_MAX_CHARS = 500
HISTORY_SHOWN = 30
VERSION_RE = re.compile(r"^\d{8}T\d{12}$")


def digest(text: str) -> str:
    """Kurzer Fingerabdruck eines Textes. Damit merkt das BFF, ob SOUL.md sich seit dem Laden geändert hat."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


class DashboardClient:
    def __init__(self, cfg: DashboardCfg, http: httpx.AsyncClient):
        self._cfg, self._http = cfg, http

    async def _call(self, method: str, path: str, *, json_body: Any = None, params: dict[str, str] | None = None) -> Any:
        headers = {"X-Hermes-Session-Token": self._cfg.token} if self._cfg.token else {}
        try:
            res = await self._http.request(method, f"{self._cfg.base_url}{path}", json=json_body, params=params, headers=headers)
        except httpx.TimeoutException as e:
            raise UpstreamError(504, "Das Dashboard antwortet nicht") from e
        except httpx.HTTPError as e:
            raise UpstreamError(503, "Das Dashboard ist nicht erreichbar") from e
        if res.status_code in (401, 403):
            raise UpstreamError(502, "Das Dashboard lehnt den Zugang ab (Token prüfen)")
        if res.status_code == 404:
            raise UpstreamError(404, "Das Dashboard kennt dieses Profil nicht")
        if res.status_code >= 400:
            raise UpstreamError(502, f"Das Dashboard meldet Fehler {res.status_code}")
        try:
            return res.json()
        except ValueError as e:
            raise UpstreamError(502, "Das Dashboard antwortet nicht im erwarteten Format") from e

    async def profiles(self) -> list[dict[str, Any]]:
        body = await self._call("GET", "/api/profiles")
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

    async def set_model(self, name: str, provider: str, model: str) -> None:
        await self._call("PUT", f"/api/profiles/{name}/model", json_body={"provider": provider, "model": model})

    # Anbieter, Keys und Nutzung eines Profils: das Profil steht als Abfrageparameter (`?profile=`), nicht im Pfad.
    async def env(self, name: str) -> Any:
        return await self._call("GET", "/api/env", params={"profile": name})

    async def oauth_providers(self, name: str) -> Any:
        return await self._call("GET", "/api/providers/oauth", params={"profile": name})

    async def model_analytics(self, name: str, days: int) -> Any:
        return await self._call("GET", "/api/analytics/models", params={"profile": name, "days": str(days)})

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

    async def validate_key(self, var: str, value: str) -> Any:
        return await self._call("POST", "/api/providers/validate", json_body={"key": var, "value": value})

    async def set_key(self, name: str, var: str, value: str) -> None:
        await self._call("PUT", "/api/env", params={"profile": name}, json_body={"key": var, "value": value})


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
