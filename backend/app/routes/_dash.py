"""Gemeinsame Helfer für Routen, die das Dashboard eines Hosts bedienen (Kanban, Erweiterungen, Zeitpläne, Logs …)."""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException, Request

from ..adapters import UpstreamError
from ..dashboard import DashboardClient
from .agents import to_http


def _dash_runtime(request: Request, host: str):
    cfg = request.app.state.registry.host(host)
    if cfg is None:
        raise HTTPException(404, "Unbekannter Host")
    for runtime in cfg.runtimes:
        if runtime.dashboard is not None:
            return runtime
    raise HTTPException(503, "Für diesen Host ist kein Dashboard eingerichtet")


def host_dash(request: Request, host: str) -> DashboardClient:
    return DashboardClient(_dash_runtime(request, host).dashboard, request.app.state.http, request.app.state.dash_cache)


def check_profile(request: Request, host: str, profile: str) -> None:
    """Das Dashboard verwaltet alle Profile der Maschine, die WebUI nur die in hosts.json geführten."""
    if profile not in {a.id for a in _dash_runtime(request, host).agents}:
        raise HTTPException(404, "Unbekanntes Profil")


async def dash(request: Request, host: str, method: str, path: str, *, body: Any = None, params: dict[str, str] | None = None,
               missing: str | None = None) -> Any:
    """Eine Dashboard-Route aufrufen; Dashboard-Fehler werden zu passenden HTTP-Fehlern des BFF."""
    if params and params.get("profile"):
        check_profile(request, host, params["profile"])
    try:
        return await host_dash(request, host).request(method, path, body=body, params=params, missing=missing)
    except UpstreamError as e:
        raise to_http(e) from e
