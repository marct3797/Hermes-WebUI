from __future__ import annotations

import asyncio
import json
import re
from collections.abc import AsyncIterator
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..auth import User, current_user
from ..hermes import ID_RE, TERMINAL_TYPES, HermesClient, UpstreamError, normalize_event
from ..profiles import PROFILE_NAME_RE

router = APIRouter(prefix="/bff", dependencies=[Depends(current_user)])

ProfileName = Annotated[str, Path(pattern=PROFILE_NAME_RE.pattern)]
ObjId = Annotated[str, Path(pattern=ID_RE.pattern)]
DATA_URL_RE = re.compile(r"^data:image/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$")
KEEPALIVE_S = 15


def client_for(request: Request, profile: str) -> HermesClient:
    p = request.app.state.profiles.get(profile)
    if p is None:
        raise HTTPException(404, "Unbekanntes Profil")
    return HermesClient(p, request.app.state.http)


Client = Annotated[HermesClient, Depends(client_for)]


async def upstream(coro):
    try:
        return await coro
    except UpstreamError as e:
        # Upstream-Details nur gekürzt weitergeben; 401/403 von Hermes ist für den Browser ein 502.
        status = 502 if e.status in (401, 403) else e.status
        raise HTTPException(status if 400 <= status < 600 else 502, e.detail) from e


# --- Profile & Status -------------------------------------------------------------------
@router.get("/profiles")
async def list_profiles(request: Request):
    return {"profiles": [p.public() for p in request.app.state.profiles.all()]}


@router.get("/p/{profile}/status")
async def profile_status(client: Client):
    """Capability-Probe. Fehler sind hier Daten, damit das UI Offline-Zustände zeigen kann."""
    try:
        caps = await client.capabilities()
        return {"online": True, "capabilities": caps}
    except UpstreamError as e:
        return {"online": False, "error": e.detail, "status": e.status}


@router.get("/p/{profile}/models")
async def models(client: Client):
    return await upstream(client.models())


# --- Sessions ---------------------------------------------------------------------------
@router.get("/p/{profile}/sessions")
async def sessions(
    client: Client,
    limit: int = Query(30, ge=1, le=100),
    offset: int = Query(0, ge=0),
    source: Literal["chat", "automation", "messaging"] | None = None,
):
    return await upstream(client.sessions(limit, offset, source))


@router.get("/p/{profile}/sessions/{session_id}/messages")
async def session_messages(client: Client, session_id: ObjId):
    return await upstream(client.session_messages(session_id))


# --- Runs -------------------------------------------------------------------------------
class RunRequest(BaseModel):
    text: str = Field(min_length=1, max_length=100_000)
    session_id: str | None = Field(default=None, pattern=ID_RE.pattern)
    model: str | None = Field(default=None, max_length=200)
    images: list[str] = Field(default_factory=list, max_length=4)


def build_run_body(req: RunRequest) -> dict[str, Any]:
    body: dict[str, Any] = {}
    if req.images:
        parts: list[dict[str, Any]] = [{"type": "text", "text": req.text}]
        parts += [{"type": "image_url", "image_url": {"url": u}} for u in req.images]
        body["input"] = [{"role": "user", "content": parts}]
    else:
        body["input"] = req.text
    if req.session_id:
        body["session_id"] = req.session_id
    if req.model:
        body["model"] = req.model
    return body


@router.post("/p/{profile}/runs", status_code=202)
async def start_run(request: Request, client: Client, req: RunRequest, user: User = Depends(current_user)):
    for url in req.images:
        if not DATA_URL_RE.match(url) or len(url) > 1_500_000:
            raise HTTPException(422, "Bild muss PNG, JPEG, WebP oder GIF (Data-URL, max. ca. 1 MB) sein")
    request.app.state.limiter.check(f"{user.id}:{client.profile.name}")
    return await upstream(client.start_run(build_run_body(req)))


@router.get("/p/{profile}/runs/{run_id}")
async def run_status(client: Client, run_id: ObjId):
    return await upstream(client.run_status(run_id))


class ApprovalRequest(BaseModel):
    approval_id: str | None = Field(default=None, pattern=ID_RE.pattern)
    decision: Literal["once", "session", "always", "deny"]


class ClarifyRequest(BaseModel):
    clarify_id: str | None = Field(default=None, pattern=ID_RE.pattern)
    answer: str = Field(max_length=10_000)


@router.post("/p/{profile}/runs/{run_id}/stop")
async def stop_run(client: Client, run_id: ObjId):
    return await upstream(client.run_action(run_id, "stop", {}))


@router.post("/p/{profile}/runs/{run_id}/approval")
async def approve(client: Client, run_id: ObjId, req: ApprovalRequest):
    return await upstream(client.run_action(run_id, "approval", req.model_dump(exclude_none=True)))


@router.post("/p/{profile}/runs/{run_id}/clarify")
async def clarify(client: Client, run_id: ObjId, req: ClarifyRequest):
    return await upstream(client.run_action(run_id, "clarify", req.model_dump(exclude_none=True)))


def sse(event: str, data: dict[str, Any]) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode()


async def event_stream(client: HermesClient, run_id: str) -> AsyncIterator[bytes]:
    upstream_iter = client.run_events(run_id).__aiter__()
    pending: asyncio.Task | None = None
    try:
        while True:
            pending = pending or asyncio.ensure_future(upstream_iter.__anext__())
            done, _ = await asyncio.wait({pending}, timeout=KEEPALIVE_S)
            if not done:
                yield b": keepalive\n\n"
                continue
            task, pending = pending, None
            try:
                name, raw = task.result()
            except StopAsyncIteration:
                return
            except UpstreamError as e:
                yield sse("stream.error", {"type": "stream.error", "error": e.detail})
                return
            ev = normalize_event(name, raw)
            yield sse(ev["type"], ev)
            if ev["type"] in TERMINAL_TYPES:
                return
    finally:
        if pending:
            pending.cancel()
        await upstream_iter.aclose()


@router.get("/p/{profile}/runs/{run_id}/events")
async def run_events(client: Client, run_id: ObjId):
    return StreamingResponse(
        event_stream(client, run_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )
