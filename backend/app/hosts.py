"""Host-Dienst des BFF: verbindet Registry, Adapter und Host-Status.

Lokale Hosts (hikari) spricht das BFF direkt an. Entfernte Hosts (laptop) bekommen in Phase 2 einen
Host-Dienst mit ausgehender Verbindung; ihr Transport kommt dann als eigener httpx-Client aus
`HostService.adapter`. Bis dahin sind sie in der Registry sichtbar, aber "nicht erreichbar".
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any

import httpx

from .adapters import AgentInfo, AgentStatus, Health, RuntimeAdapter, UpstreamError, adapter_classes
from .registry import AgentCfg, HostCfg, Registry, RuntimeCfg

REMOTE_PENDING = "Host-Dienst nicht verbunden (folgt in Phase 2)"


class OfflineAdapter(RuntimeAdapter):
    """Platzhalter für Hosts ohne Verbindung: Status "nicht erreichbar", alle Aufrufe melden 503.

    Phase 2 ersetzt ihn für entfernte Hosts durch den echten Adapter mit dem Transport des Host-Dienstes.
    """

    def __init__(self, runtime: RuntimeCfg, reason: str):
        self.id, self.label, self.cfg, self._reason = runtime.id, runtime.id, runtime, reason

    def agents(self) -> list[AgentInfo]:
        return [AgentInfo(a.id, a.label) for a in self.cfg.agents]

    async def health(self) -> Health:
        return Health("unreachable", detail=self._reason)

    async def probe(self, agent: str) -> AgentStatus:
        return AgentStatus("unreachable", error=self._reason)

    async def _unavailable(self, *_args, **_kwargs):
        raise UpstreamError(503, self._reason)

    models = sessions = session_messages = fork_session = rename_session = delete_session = start_run = run_status = _unavailable
    stop = approve = clarify = steer = _unavailable

    async def events(self, agent: str, run_id: str):
        raise UpstreamError(503, self._reason)
        yield  # macht die Methode zum Generator


@dataclass(frozen=True)
class Target:
    host: HostCfg
    runtime: RuntimeCfg
    agent: AgentCfg
    adapter: RuntimeAdapter

    @property
    def label(self) -> str:
        return f"{self.host.id}/{self.runtime.id}/{self.agent.id}"


class HostService:
    def __init__(self, registry: Registry, http: httpx.AsyncClient, *, health_ttl: float, health_timeout: float):
        self.registry, self._http = registry, http
        self._ttl, self._timeout = health_ttl, health_timeout
        self._adapters: dict[tuple[str, str], RuntimeAdapter] = {}
        self._health: dict[tuple[str, str], tuple[float, Health]] = {}

    def adapter(self, host: HostCfg, runtime: RuntimeCfg) -> RuntimeAdapter:
        cached = self._adapters.get((host.id, runtime.id))
        if cached is not None and getattr(cached, "cfg", None) is runtime:
            return cached  # unveränderte Config: Adapter wiederverwenden
        cls = adapter_classes().get(runtime.id)
        if cls is None:
            adapter: RuntimeAdapter = OfflineAdapter(runtime, f"Für {runtime.id} gibt es noch keinen Adapter")
        elif host.kind == "local":
            adapter = cls(runtime, self._http, health_timeout=self._timeout)
        else:
            adapter = OfflineAdapter(runtime, REMOTE_PENDING)
        self._adapters[(host.id, runtime.id)] = adapter
        return adapter

    def target(self, host_id: str, runtime_id: str, agent_id: str) -> Target | None:
        """None, wenn Host, Runtime oder Agent nicht (mehr) in der Registry stehen."""
        host = self.registry.host(host_id)
        runtime = host.runtime(runtime_id) if host else None
        agent = next((a for a in runtime.agents if a.id == agent_id), None) if runtime else None
        if not (host and runtime and agent):
            return None
        return Target(host, runtime, agent, self.adapter(host, runtime))

    async def _runtime_health(self, host: HostCfg, runtime: RuntimeCfg) -> Health:
        key = (host.id, runtime.id)
        hit = self._health.get(key)
        if hit and time.monotonic() - hit[0] < self._ttl:
            return hit[1]
        try:
            health = await self.adapter(host, runtime).health()
        except UpstreamError as e:
            health = Health("unreachable", detail=e.detail)
        self._health[key] = (time.monotonic(), health)
        return health

    async def overview(self) -> dict[str, Any]:
        hosts = self.registry.hosts()
        pairs = [(h, r) for h in hosts for r in h.runtimes]
        results = await asyncio.gather(*(self._runtime_health(h, r) for h, r in pairs))
        by_key = {(h.id, r.id): res for (h, r), res in zip(pairs, results, strict=True)}

        out = []
        for h in hosts:
            runtimes = []
            for r in h.runtimes:
                res = by_key[(h.id, r.id)]
                runtimes.append({
                    "id": r.id, "label": adapter_label(r.id), "status": res.state, "version": res.version,
                    "detail": res.detail, "multiplex": r.multiplex,
                    "agents": [{"id": a.id, "label": a.label} for a in r.agents],
                })
            states = [x["status"] for x in runtimes]
            status = "online" if (not runtimes and h.kind == "local") or "online" in states else "unreachable"
            detail = next((x["detail"] for x in runtimes if x["detail"] and x["status"] != "online"), None)
            out.append({"id": h.id, "label": h.label, "kind": h.kind, "address": h.address,
                        "status": status, "detail": None if status == "online" else detail, "runtimes": runtimes})
        return {"hosts": out, "config_error": self.registry.error}


def adapter_label(runtime_id: str) -> str:
    cls = adapter_classes().get(runtime_id)
    return cls.label if cls else runtime_id

