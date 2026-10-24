"""Gemeinsame Helfer für Routen, die das Dashboard eines Hosts bedienen (Kanban, Erweiterungen, Zeitpläne, Logs …)."""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException, Request

from ..adapters import UpstreamError
from ..dashboard import DashboardClient
from .agents import to_http


def host_dash(request: Request, host: str) -> DashboardClient:
    cfg = request.app.state.registry.host(host)
    if cfg is None:
        raise HTTPException(404, "Unbekannter Host")
    for runtime in cfg.runtimes:
        if runtime.dashboard is not None:
            return DashboardClient(runtime.dashboard, request.app.state.http, request.app.state.dash_cache)
    raise HTTPException(503, "Für diesen Host ist kein Dashboard eingerichtet")


async def dash(request: Request, host: str, method: str, path: str, *, body: Any = None, params: dict[str, str] | None = None,
               missing: str | None = None) -> Any:
    """Eine Dashboard-Route aufrufen; Dashboard-Fehler werden zu passenden HTTP-Fehlern des BFF."""
    try:
        return await host_dash(request, host).request(method, path, body=body, params=params, missing=missing)
    except UpstreamError as e:
        raise to_http(e) from e
