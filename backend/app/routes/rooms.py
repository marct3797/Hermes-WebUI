"""Gruppenchat-Routen: /bff/rooms/… Den Ablauf führt app/rooms.py; die Mitglieder laufen als normale Runs ihrer Agents."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..auth import User, current_user
from ..registry import AGENT_RE, ID_RE
from ..rooms import MAX_MEMBERS, MIN_MEMBERS, ROOM_ID_RE, RoomEngine, RoomError, member_key, stream
from ..security import client_ip
from .agents import KEEPALIVE_S, sse

router = APIRouter(prefix="/bff/rooms", dependencies=[Depends(current_user)])

RoomId = Annotated[str, Path(pattern=ROOM_ID_RE.pattern)]


def engine_of(request: Request) -> RoomEngine:
    try:
        return request.app.state.rooms.engine
    except RoomError as e:
        raise HTTPException(e.status, e.detail) from e


Engine = Annotated[RoomEngine, Depends(engine_of)]


def audit(request: Request, user: User, action: str, room: str, **detail) -> None:
    request.app.state.audit.record(action, user=user.id, ip=client_ip(request, request.app.state.settings), target=f"room/{room}", **detail)


def public(engine: RoomEngine, room: dict, *, messages: list | None = None) -> dict:
    out = {
        "id": room["id"], "name": room["name"], "archived": room["archived"], "needs_user": room["needs_user"],
        "created_at": room["created_at"], **engine.status(room["id"]),
        "members": [{**m, "label": engine.label_of(m), "key": member_key(m)} for m in room["members"]],
    }
    if "last_message" in room:
        out["last_message"] = room["last_message"]
    if messages is not None:
        out["messages"] = messages
    return out


def get_room(engine: RoomEngine, room_id: str) -> dict:
    room = engine.store.get(room_id)
    if room is None:
        raise HTTPException(404, "Unbekannter Raum")
    return room


class MemberIn(BaseModel):
    host: str = Field(pattern=ID_RE.pattern)
    runtime: str = Field(pattern=ID_RE.pattern)
    agent: str = Field(pattern=AGENT_RE.pattern)


class RoomIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    members: list[MemberIn] = Field(min_length=MIN_MEMBERS, max_length=MAX_MEMBERS)


class RoomPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    archived: bool | None = None


class MessageIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


@router.get("")
async def list_rooms(engine: Engine, archived: bool = False):
    return {"rooms": [public(engine, r) for r in engine.store.rooms() if r["archived"] == archived]}


@router.post("", status_code=201)
async def create_room(request: Request, engine: Engine, req: RoomIn, user: User = Depends(current_user)):
    members = [m.model_dump() for m in req.members]
    keys = [member_key(m) for m in members]
    if len(set(keys)) != len(keys):
        raise HTTPException(422, "Ein Agent kann nur einmal im Raum sein")
    labels = []
    for m in members:
        target = request.app.state.hosts.target(m["host"], m["runtime"], m["agent"])
        if target is None:
            raise HTTPException(404, f"Unbekannter Agent: {member_key(m)}")
        labels.append(target.agent.label.lower())
    if len(set(labels)) != len(labels):
        # @Name muss ein Mitglied eindeutig treffen.
        raise HTTPException(422, "Zwei Mitglieder tragen denselben Namen; ändere einen Anzeigenamen in der hosts.json")
    room = engine.store.create(req.name.strip(), members, user.id)
    audit(request, user, "room.create", room["id"], members=len(members))
    return public(engine, room, messages=[])


@router.get("/{room_id}")
async def read_room(engine: Engine, room_id: RoomId, after: int = Query(0, ge=0), limit: int = Query(200, ge=1, le=500)):
    room = get_room(engine, room_id)
    return public(engine, room, messages=engine.store.messages(room_id, after, limit))


@router.patch("/{room_id}")
async def patch_room(request: Request, engine: Engine, room_id: RoomId, req: RoomPatch, user: User = Depends(current_user)):
    room = get_room(engine, room_id)
    fields = {k: v for k, v in req.model_dump().items() if v is not None}
    if fields.get("archived") and room_id in engine.turns:
        raise HTTPException(409, "Der Raum arbeitet noch")
    engine.store.update(room_id, **fields)
    audit(request, user, "room.update", room_id, fields=",".join(fields))
    return public(engine, get_room(engine, room_id))


@router.post("/{room_id}/messages", status_code=202)
async def send_message(request: Request, engine: Engine, room_id: RoomId, req: MessageIn, user: User = Depends(current_user)):
    get_room(engine, room_id)
    request.app.state.limiter.check(f"{user.id}:rooms")
    try:
        msg = await engine.send(room_id, req.text.strip(), user.id)
    except RoomError as e:
        raise HTTPException(e.status, e.detail) from e
    audit(request, user, "room.message", room_id, chars=len(req.text))
    return {"message": msg}


@router.post("/{room_id}/stop")
async def stop_room(request: Request, engine: Engine, room_id: RoomId, user: User = Depends(current_user)):
    get_room(engine, room_id)
    stopped = await engine.stop(room_id)
    if stopped:
        audit(request, user, "room.stop", room_id)
    return {"stopped": stopped}


@router.get("/{room_id}/events")
async def room_events(engine: Engine, room_id: RoomId):
    get_room(engine, room_id)

    async def gen():
        async for ev in stream(engine, room_id, KEEPALIVE_S):
            yield b": keepalive\n\n" if ev is None else sse(ev)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
