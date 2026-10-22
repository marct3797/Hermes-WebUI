"""Host- und Agent-Registry aus der Config-Datei (`hosts.json`).

Begriffe: Ein Host ist ein Rechner, eine Runtime ein Agent-System darauf (z. B. Hermes), ein Agent
ein Profil oder Projekt dieser Runtime. Die Datei wird bei jeder Abfrage per mtime geprüft, so
erscheinen neue Agents ohne Neustart und gelöschte verschwinden. Ist die Datei kaputt, bleibt die
letzte gültige Fassung aktiv und der Fehler wird gemeldet.

Keys stehen in einer Umgebungsvariablen (`api_key_env`) oder, nur für Entwicklung, in der Datei
(`api_key`). Sie verlassen den BFF nie.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")  # Host- und Runtime-Kennung (landet in URLs)
AGENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")  # Profilordner heißen so


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class AgentCfg:
    id: str
    label: str


@dataclass(frozen=True)
class RuntimeCfg:
    id: str
    base_url: str
    api_key: str = field(repr=False, default="")
    multiplex: bool = False  # Hermes: Profile unter /p/<profil>/ statt eigenem Port
    agents: tuple[AgentCfg, ...] = ()


@dataclass(frozen=True)
class HostCfg:
    id: str
    label: str
    kind: Literal["local", "remote"]
    address: str | None = None
    runtimes: tuple[RuntimeCfg, ...] = ()

    def runtime(self, runtime_id: str) -> RuntimeCfg | None:
        return next((r for r in self.runtimes if r.id == runtime_id), None)


def parse_config(raw: Any, environ: dict[str, str] | None = None) -> dict[str, HostCfg]:
    env = os.environ if environ is None else environ
    if not isinstance(raw, dict) or not isinstance(raw.get("hosts"), list):
        raise ConfigError('Erwartet {"hosts": [...]}')
    hosts: dict[str, HostCfg] = {}
    for h in raw["hosts"]:
        host_id = str(h.get("id", ""))
        if not ID_RE.match(host_id):
            raise ConfigError(f"Ungültige Host-Kennung: {host_id!r}")
        if host_id in hosts:
            raise ConfigError(f"Host doppelt: {host_id}")
        kind = h.get("kind", "local")
        if kind not in ("local", "remote"):
            raise ConfigError(f"{host_id}: kind muss local oder remote sein")
        runtimes: list[RuntimeCfg] = []
        for r in h.get("runtimes", []):
            runtime_id = str(r.get("id", ""))
            if not ID_RE.match(runtime_id):
                raise ConfigError(f"{host_id}: ungültige Runtime-Kennung {runtime_id!r}")
            if "base_url" not in r:
                raise ConfigError(f"{host_id}/{runtime_id}: base_url fehlt")
            agents = []
            for a in r.get("agents", []):
                entry = {"id": a} if isinstance(a, str) else a
                agent_id = str(entry.get("id", ""))
                if not AGENT_RE.match(agent_id):
                    continue  # ungültige Namen nie in Upstream-URLs übernehmen
                agents.append(AgentCfg(agent_id, str(entry.get("label") or agent_id)))
            multiplex = bool(r.get("multiplex", False))
            if not multiplex and len(agents) > 1:
                # Ohne Multiplex ignoriert Hermes das Profil-Präfix: alle Agents landeten im Default.
                raise ConfigError(f"{host_id}/{runtime_id}: ohne multiplex ist genau ein Agent möglich")
            key = r.get("api_key") or env.get(str(r.get("api_key_env", "")), "")
            runtimes.append(RuntimeCfg(
                id=runtime_id, base_url=str(r["base_url"]).rstrip("/"), api_key=key,
                multiplex=multiplex, agents=tuple(agents),
            ))
        hosts[host_id] = HostCfg(
            id=host_id, label=str(h.get("label") or host_id), kind=kind,
            address=h.get("address"), runtimes=tuple(runtimes),
        )
    return hosts


class Registry:
    def __init__(self, path: Path):
        self._path = path
        self._mtime: float | None = None
        self._hosts: dict[str, HostCfg] = {}
        self.error: str | None = None

    def _load(self) -> None:
        try:
            mtime = self._path.stat().st_mtime
        except FileNotFoundError:
            self._mtime, self._hosts = None, {}
            self.error = f"{self._path.name} fehlt"
            return
        if mtime == self._mtime:
            return
        self._mtime = mtime  # auch bei Fehlern, damit eine kaputte Datei nicht bei jeder Abfrage neu geparst wird
        try:
            self._hosts = parse_config(json.loads(self._path.read_text(encoding="utf-8")))
            self.error = None
        except (ValueError, ConfigError, AttributeError, TypeError) as e:
            self.error = f"{self._path.name} ist ungültig: {e}"

    def hosts(self) -> list[HostCfg]:
        self._load()
        return list(self._hosts.values())

    def host(self, host_id: str) -> HostCfg | None:
        self._load()
        return self._hosts.get(host_id)
