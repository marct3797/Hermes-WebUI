"""Agent-Routen: /bff/h/<host>/<runtime>/<agent>/… Alles Runtime-Spezifische erledigt der Adapter."""
from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import AsyncIterator
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..adapters import RunInput, UpstreamError
from ..auth import User, current_user, fresh_user
from ..diagnose import inspect, run_test, summarize
from ..events import TERMINAL_TYPES, Event
from ..hosts import Target
from ..registry import AGENT_RE, ID_RE
from ..security import client_ip

router = APIRouter(prefix="/bff/h/{host}/{runtime}/{agent}", dependencies=[Depends(current_user)])

# IDs landen in Upstream-Pfaden: nur harmlose Zeichen zulassen (kein "/", kein "..").
OBJ_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
DATA_URL_RE = re.compile(r"^data:image/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$")
KEEPALIVE_S = 15

HostId = Annotated[str, Path(pattern=ID_RE.pattern)]
RuntimeId = Annotated[str, Path(pattern=ID_RE.pattern)]
AgentId = Annotated[str, Path(pattern=AGENT_RE.pattern)]
ObjId = Annotated[str, Path(pattern=OBJ_ID_RE.pattern)]


def resolve_target(request: Request, host: HostId, runtime: RuntimeId, agent: AgentId) -> Target:
    target = request.app.state.hosts.target(host, runtime, agent)
    if target is None:
        raise HTTPException(404, "Unbekannter Agent")
    return target


Tgt = Annotated[Target, Depends(resolve_target)]


async def upstream(coro):
    try:
        return await coro
    except UpstreamError as e:
        # Upstream-Details nur gekürzt weitergeben; 401/403 der Runtime ist für den Browser ein 502.
        status = 502 if e.status in (401, 403) else e.status
        raise HTTPException(status if 400 <= status < 600 else 502, e.detail) from e


def audit(request: Request, user: User, action: str, target: Target, **detail: Any) -> None:
    settings = request.app.state.settings
    request.app.state.audit.record(action, user=user.id, ip=client_ip(request, settings), target=target.label, **detail)


# --- Status & Lesen -----------------------------------------------------------------------
@router.get("/status")
async def agent_status(target: Tgt):
    """Capability-Probe. Fehler sind hier Daten, damit das UI Offline-Zustände zeigen kann."""
    try:
        return (await target.adapter.probe(target.agent.id)).public()
    except UpstreamError as e:
        return {"state": "unreachable", "online": False, "version": None, "features": [], "error": e.detail}


@router.get("/diagnose")
async def diagnose(target: Tgt):
    """Diagnose-Ring: liest nur und prüft, ob die Antworten dieses Agents die Form haben, die die WebUI erwartet."""
    checks = await inspect(target.adapter, target.agent.id)
    return {"agent": target.label, "status": summarize(checks), "checks": checks, "at": time.time()}


@router.post("/diagnose/run")
async def diagnose_run(request: Request, target: Tgt, user: User = Depends(current_user)):
    """Lauftest: ein kurzer echter Lauf (legt eine Session an). Nur auf Knopfdruck."""
    request.app.state.limiter.check(f"{user.id}:{target.label}")
    checks = await run_test(target.adapter, target.agent.id)
    audit(request, user, "diagnose.run", target, status=summarize(checks))
    return {"agent": target.label, "status": summarize(checks), "checks": checks, "at": time.time()}


@router.get("/models")
async def models(target: Tgt):
    return await upstream(target.adapter.models(target.agent.id))


@router.get("/sessions")
async def sessions(
    target: Tgt,
    limit: int = Query(30, ge=1, le=100),
    offset: int = Query(0, ge=0),
    source: Literal["chat", "automation", "messaging"] | None = None,
):
    return await upstream(target.adapter.sessions(target.agent.id, limit=limit, offset=offset, source=source))


@router.get("/sessions/{session_id}/messages")
async def session_messages(
    target: Tgt, session_id: ObjId,
    limit: int | None = Query(None, ge=1, le=500), offset: int | None = Query(None, ge=0),
):
    return await upstream(target.adapter.session_messages(target.agent.id, session_id, limit=limit, offset=offset))


@router.post("/sessions/{session_id}/fork")
async def fork_session(request: Request, target: Tgt, session_id: ObjId, user: User = Depends(current_user)):
    """Zweig einer Session: weiterschreiben, wenn die Quelle gesperrt ist (z. B. eine Chat-Plattform-Session)."""
    result = await upstream(target.adapter.fork_session(target.agent.id, session_id))
    audit(request, user, "session.fork", target, session=session_id, fork=result.get("session_id"))
    return result


# --- Runs -------------------------------------------------------------------------------
class RunRequest(BaseModel):
    text: str = Field(min_length=1, max_length=100_000)
    session_id: str | None = Field(default=None, pattern=OBJ_ID_RE.pattern)
    model: str | None = Field(default=None, max_length=200)
    images: list[str] = Field(default_factory=list, max_length=4)
    idempotency_key: str | None = Field(default=None, pattern=OBJ_ID_RE.pattern)


@router.post("/runs", status_code=202)
async def start_run(request: Request, target: Tgt, req: RunRequest, user: User = Depends(current_user)):
    for url in req.images:
        if not DATA_URL_RE.match(url) or len(url) > 1_500_000:
            raise HTTPException(422, "Bild muss PNG, JPEG, WebP oder GIF (Data-URL, max. ca. 1 MB) sein")
    request.app.state.limiter.check(f"{user.id}:{target.label}")
    info = await upstream(target.adapter.start_run(target.agent.id, RunInput(
        text=req.text, session_id=req.session_id, model=req.model, images=tuple(req.images), idempotency_key=req.idempotency_key,
    )))
    # Nie den Inhalt loggen, nur Umfang und Ziel.
    audit(request, user, "run.start", target, session=info.session_id or req.session_id, run=info.run_id,
          chars=len(req.text), images=len(req.images), model=req.model)
    return {"run_id": info.run_id, "session_id": info.session_id}


@router.get("/runs/{run_id}")
async def run_status(target: Tgt, run_id: ObjId):
    return await upstream(target.adapter.run_status(target.agent.id, run_id))


class ApprovalRequest(BaseModel):
    decision: Literal["once", "session", "always", "deny"]


class ClarifyRequest(BaseModel):
    clarify_id: str | None = Field(default=None, pattern=OBJ_ID_RE.pattern)
    answer: str = Field(max_length=10_000)


class SteerRequest(BaseModel):
    text: str = Field(min_length=1, max_length=10_000)


@router.post("/runs/{run_id}/stop")
async def stop_run(request: Request, target: Tgt, run_id: ObjId, user: User = Depends(current_user)):
    await upstream(target.adapter.stop(target.agent.id, run_id))
    audit(request, user, "run.stop", target, run=run_id)
    return {"ok": True}


@router.post("/runs/{run_id}/approval")
async def approve(request: Request, target: Tgt, run_id: ObjId, req: ApprovalRequest, user: User = Depends(current_user)):
    if req.decision == "always":
        # Dauerhafte Erlaubnis ist riskant: verlangt eine frische Anmeldung (Step-up).
        user = await fresh_user(request, user)
    await upstream(target.adapter.approve(target.agent.id, run_id, req.decision))
    audit(request, user, "approval", target, run=run_id, decision=req.decision)
    return {"ok": True}


@router.post("/runs/{run_id}/clarify")
async def clarify(request: Request, target: Tgt, run_id: ObjId, req: ClarifyRequest, user: User = Depends(current_user)):
    await upstream(target.adapter.clarify(target.agent.id, run_id, req.answer, req.clarify_id))
    audit(request, user, "clarify", target, run=run_id, chars=len(req.answer))
    return {"ok": True}


@router.post("/runs/{run_id}/steer")
async def steer(request: Request, target: Tgt, run_id: ObjId, req: SteerRequest, user: User = Depends(current_user)):
    await upstream(target.adapter.steer(target.agent.id, run_id, req.text))
    audit(request, user, "run.steer", target, run=run_id, chars=len(req.text))
    return {"ok": True}


def sse(data: dict[str, Any]) -> bytes:
    """Unbenannter SSE-Frame: Der Typ steckt im JSON, wie bei Hermes selbst."""
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n".encode()


async def event_stream(upstream_iter: AsyncIterator[Event], first: Event) -> AsyncIterator[bytes]:
    yield sse(first)
    if first["type"] in TERMINAL_TYPES:
        await upstream_iter.aclose()
        return
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
                ev = task.result()
            except StopAsyncIteration:
                # Strom endete ohne Abschluss-Event: das UI soll den Run-Status nachladen.
                yield sse({"type": "stream.error", "error": "Verbindung zur Runtime beendet"})
                return
            except UpstreamError as e:
                yield sse({"type": "stream.error", "error": e.detail})
                return
            yield sse(ev)
            if ev["type"] in TERMINAL_TYPES:
                return
    finally:
        if pending:
            pending.cancel()
        await upstream_iter.aclose()


@router.get("/runs/{run_id}/events")
async def run_events(target: Tgt, run_id: ObjId):
    upstream_iter = target.adapter.events(target.agent.id, run_id).__aiter__()
    try:
        # Das erste Event kommt erst, wenn die Verbindung steht: Fehler (404, 502) bekommen so einen echten Status.
        first = await upstream_iter.__anext__()
    except StopAsyncIteration:
        first = {"type": "stream.error", "error": "Runtime lieferte keine Ereignisse"}
    except UpstreamError as e:
        await upstream_iter.aclose()
        status = 502 if e.status in (401, 403) else e.status
        raise HTTPException(status if 400 <= status < 600 else 502, e.detail) from e
    return StreamingResponse(
        event_stream(upstream_iter, first),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )
