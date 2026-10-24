"""Wissens-Routen: /bff/knowledge/<anbieter>/… Alles Anbieter-Spezifische erledigt app/knowledge.py. Schreiben nur mit frischer Anmeldung (Step-up)."""
from __future__ import annotations

import re
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from pydantic import BaseModel, Field, field_validator

from ..adapters import UpstreamError
from ..auth import User, current_user, fresh_user
from ..knowledge import ID_RE, INGEST_MAX, PROVIDER_TYPES, KnowledgeProvider
from ..security import client_ip
from .memory import upstream

router = APIRouter(prefix="/bff/knowledge", dependencies=[Depends(current_user)])

ProviderId = Annotated[str, Path(pattern=ID_RE.pattern)]
CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def provider_of(request: Request, provider_id: ProviderId) -> KnowledgeProvider:
    cfg = request.app.state.knowledge.providers().get(provider_id)
    if cfg is None:
        raise HTTPException(404, "Unbekannter Wissens-Anbieter")
    s = request.app.state.settings
    return PROVIDER_TYPES[cfg.type](cfg, request.app.state.http, request.app.state.__dict__.setdefault("knowledge_cache", {}), s.knowledge_cache_s)


Prov = Annotated[KnowledgeProvider, Depends(provider_of)]


@router.get("")
async def list_providers(request: Request):
    reg = request.app.state.knowledge
    cache = request.app.state.__dict__.setdefault("knowledge_cache", {})
    return {"providers": [PROVIDER_TYPES[c.type](c, request.app.state.http, cache).public() for c in reg.providers().values()], "config_error": reg.error}


@router.get("/{provider_id}/stats")
async def stats(provider: Prov):
    try:
        return await provider.stats()
    except UpstreamError as e:  # Fehler sind hier Daten: die Seite zeigt den Grund statt einer leeren Fläche
        return {"reachable": False, "reason": e.detail}


@router.get("/{provider_id}/sources")
async def sources(provider: Prov):
    return await upstream(provider.sources())


@router.get("/{provider_id}/documents")
async def documents(provider: Prov, source: str | None = Query(None, max_length=200), q: str | None = Query(None, max_length=200),
                    limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0)):
    return await upstream(provider.documents(source, q, limit, offset))


SyncId = Annotated[str, Path(min_length=1, max_length=300, pattern=r"^[^\x00-\x1f\x7f]+$")]


@router.get("/{provider_id}/documents/{sync_id:path}")
async def document(provider: Prov, sync_id: SyncId):
    return await upstream(provider.document(sync_id))


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    top_k: int = Field(8, ge=1, le=20)
    source: str | None = Field(None, max_length=200)


@router.post("/{provider_id}/search")
async def search(provider: Prov, req: SearchRequest):
    return {"results": await upstream(provider.search(req.query, req.top_k, req.source or None))}


class IngestRequest(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    text: str = Field(min_length=1, max_length=INGEST_MAX)
    source: str = Field("manual", min_length=1, max_length=100, pattern=r"^[^\x00-\x1f\x7f]+$")

    @field_validator("title")
    @classmethod
    def _title(cls, v: str) -> str:
        v = v.strip()
        if not v or CONTROL.search(v):
            raise ValueError("Titel leer oder mit Steuerzeichen")
        return v


class ReplaceRequest(BaseModel):
    model_config = {"extra": "forbid"}
    title: str | None = Field(None, min_length=1, max_length=120)
    text: str = Field(min_length=1, max_length=INGEST_MAX)

    @field_validator("title")
    @classmethod
    def _title(cls, v: str | None) -> str | None:
        if v is not None and (not v.strip() or CONTROL.search(v)):
            raise ValueError("Titel leer oder mit Steuerzeichen")
        return v.strip() if v else v


class DeleteRequest(BaseModel):
    sync_id: str = Field(min_length=1, max_length=300, pattern=r"^[^\x00-\x1f\x7f]+$")


def _audit(request: Request, user: User, action: str, provider: KnowledgeProvider, **detail) -> None:
    request.app.state.audit.record(action, user=user.id, ip=client_ip(request, request.app.state.settings), target=f"knowledge/{provider.cfg.id}", **detail)


@router.post("/{provider_id}/ingest")
async def ingest(request: Request, provider: Prov, req: IngestRequest, user: User = Depends(fresh_user)):
    result = await upstream(provider.ingest(req.title, req.text, req.source))
    _audit(request, user, "knowledge.ingest", provider, sync_id=result["sync_id"], chars=len(req.text))  # nie der Text selbst
    return result


@router.post("/{provider_id}/delete")
async def delete(request: Request, provider: Prov, req: DeleteRequest, user: User = Depends(fresh_user)):
    result = await upstream(provider.delete(req.sync_id))
    _audit(request, user, "knowledge.delete", provider, sync_id=req.sync_id)
    return result


@router.put("/{provider_id}/documents/{sync_id:path}")
async def replace(request: Request, provider: Prov, sync_id: SyncId, req: ReplaceRequest, user: User = Depends(fresh_user)):
    result = await upstream(provider.replace(sync_id, req.title, req.text))
    _audit(request, user, "knowledge.update", provider, sync_id=sync_id, chars=len(req.text), chunks=result["chunks"], removed=result["removed"])  # nie der Text selbst
    return result
