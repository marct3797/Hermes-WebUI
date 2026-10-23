"""Gedächtnis-Routen: /bff/memory/<anbieter>/… Alles Anbieter-Spezifische erledigt app/memory.py."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from pydantic import BaseModel, Field

from ..adapters import UpstreamError
from ..auth import User, current_user
from ..memory import GRAPH_TYPES, ID_RE, OBJ_RE, PROVIDER_TYPES, MemoryProvider, TTLCache
from ..security import client_ip

router = APIRouter(prefix="/bff/memory", dependencies=[Depends(current_user)])

ProviderId = Annotated[str, Path(pattern=ID_RE.pattern)]
EntityId = Annotated[str, Path(pattern=OBJ_RE.pattern)]
Kind = Annotated[str | None, Query(pattern=r"^[a-z_]{1,24}$")]


def provider_of(request: Request, provider_id: ProviderId) -> MemoryProvider:
    cfg = request.app.state.memory.providers().get(provider_id)
    if cfg is None:
        raise HTTPException(404, "Unbekannter Gedächtnis-Anbieter")
    return PROVIDER_TYPES[cfg.type](cfg, request.app.state.http)


Prov = Annotated[MemoryProvider, Depends(provider_of)]


async def upstream(coro):
    try:
        return await coro
    except UpstreamError as e:
        raise HTTPException(e.status if 400 <= e.status < 600 else 502, e.detail) from e


@router.get("")
async def list_providers(request: Request):
    registry = request.app.state.memory
    providers = registry.providers()
    return {
        "providers": [PROVIDER_TYPES[c.type](c, request.app.state.http).public() for c in providers.values()],
        "config_error": registry.error,
    }


async def cached(request: Request, key: tuple, ttl: float, refresh: bool, load):
    """Gleiche Anfrage binnen `ttl` Sekunden kommt aus dem Speicher; `?refresh=1` holt neu."""
    cache = request.app.state.__dict__.setdefault("memcache", TTLCache(32))
    hit = None if refresh else cache.get(key, ttl)
    if hit is not None:
        return hit
    value = await upstream(load())
    cache.put(key, value)
    return value


@router.get("/{provider_id}/stats")
async def stats(request: Request, provider: Prov, refresh: bool = False):
    return {"counts": await cached(request, ("stats", provider.cfg.id), 30, refresh, provider.stats)}


@router.get("/{provider_id}/items")
async def items(provider: Prov, q: str | None = Query(None, max_length=200), kind: Kind = None,
                limit: int = Query(30, ge=1, le=100), offset: int = Query(0, ge=0)):
    return await upstream(provider.items(q, kind, limit, offset))


@router.get("/{provider_id}/search")
async def search(provider: Prov, q: str = Query(min_length=1, max_length=500), kind: Kind = None, limit: int = Query(20, ge=1, le=50)):
    return {"items": await upstream(provider.search(q, kind, limit))}


Tag = Annotated[str, Query(pattern=r"^[\w .:@/+-]{1,64}$")]
Period = Annotated[str, Query(pattern=r"^(1d|7d|30d|90d|365d)$")]


@router.get("/{provider_id}/graph")
async def graph(request: Request, provider: Prov, type: Annotated[str, Query(pattern="^(" + "|".join(GRAPH_TYPES) + ")$")] = "world",
                limit: int = Query(500, ge=1, le=2000), q: str | None = Query(None, max_length=200),
                tags: Annotated[list[Tag] | None, Query(max_length=10)] = None, tags_match: Annotated[str, Query(pattern="^(any|all)$")] = "any",
                refresh: bool = False):
    key = ("graph", provider.cfg.id, type, limit, q or "", tuple(tags or ()), tags_match)
    return await cached(request, key, 60, refresh, lambda: provider.graph(q, limit, type, tags, tags_match))


@router.get("/{provider_id}/timeseries")
async def timeseries(provider: Prov, type: Annotated[str, Query(pattern="^(" + "|".join(GRAPH_TYPES) + ")$")] = "world", period: Period = "30d"):
    return await upstream(provider.timeseries(type, period))


@router.get("/{provider_id}/entities")
async def entities(provider: Prov, limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)):
    return await upstream(provider.entities(limit, offset))


@router.get("/{provider_id}/entities/{entity_id}")
async def entity(provider: Prov, entity_id: EntityId):
    return await upstream(provider.entity(entity_id))


@router.get("/{provider_id}/models")
async def models(provider: Prov):
    return {"items": await upstream(provider.models())}


@router.get("/{provider_id}/diagnose")
async def diagnose(provider: Prov):
    checks = await provider.diagnose()
    states = {c["status"] for c in checks}
    return {"agent": f"Gedächtnis/{provider.cfg.id}", "status": "fail" if "fail" in states else "warn" if "warn" in states else "ok", "checks": checks}


class ReflectRequest(BaseModel):
    query: str = Field(min_length=1, max_length=1000)


@router.post("/{provider_id}/reflect")
async def reflect(request: Request, provider: Prov, req: ReflectRequest, user: User = Depends(current_user)):
    """Lässt den Anbieter aus dem Gedächtnis antworten. Das ruft dort ein Sprachmodell auf und kostet: darum POST, begrenzt und im Audit."""
    request.app.state.limiter.check(f"{user.id}:memory:{provider.cfg.id}")
    result = await upstream(provider.reflect(req.query))
    request.app.state.audit.record("memory.reflect", user=user.id, ip=client_ip(request, request.app.state.settings),
                                   target=f"memory/{provider.cfg.id}", chars=len(req.query))
    return result
