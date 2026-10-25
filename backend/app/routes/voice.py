"""Sprache (Punkt 10). Schranken siehe tests/test_hermes_voice.py.

Nicht durchgereicht: `voice-config` (liefert Anbieter-Schlüssel an den Client), `voice-live/session`, Leases und die WebSockets (Dauerverbindungen).
"""
from __future__ import annotations

import base64
import binascii
import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from ..auth import User, current_user
from .agents import Tgt, upstream
from .dashboard import Dash

router = APIRouter(prefix="/bff/h/{host}/{runtime}/{agent}", dependencies=[Depends(current_user)])

MAX_AUDIO_BYTES = 1_400_000  # das globale Body-Limit des BFF liegt bei 2 MiB; Base64 braucht ein Drittel mehr
MAX_REPLY_CHARS = 12_000_000  # Base64 von rund 9 MB Audio
UPLOAD = re.compile(r"^data:(audio/[\w.+-]+|video/webm)(;[\w=.+-]+)*;base64,([A-Za-z0-9+/]+={0,2})$")
MIME = re.compile(r"^(audio/[\w.+-]+|video/webm)$")


def _limit(request: Request, user: User) -> None:
    request.app.state.limiter.check(f"{user.id}:hermes-voice")  # Anbieter für Sprache können Geld kosten


@router.get("/hermes-voice/status")
async def status(target: Tgt, dash: Dash):
    b = await upstream(dash.request("GET", "/api/audio/voice-live/status", params={"profile": target.agent.id}))
    if not isinstance(b, dict):
        raise HTTPException(502, "Das Dashboard liefert den Sprachstatus in unbekannter Form")
    return {"mode": str(b.get("mode", ""))[:30], "available": bool(b.get("available")), "reason": str(b.get("reason") or "")[:300]}


class SpeakIn(BaseModel):
    model_config = {"extra": "forbid"}
    text: str = Field(max_length=1000)

    @field_validator("text")
    @classmethod
    def _t(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Text: leer")
        return v.strip()


@router.post("/hermes-voice/speak")
async def speak(request: Request, target: Tgt, dash: Dash, req: SpeakIn, user: User = Depends(current_user)):
    _limit(request, user)
    b = await upstream(dash.request("POST", "/api/audio/speak", body={"text": req.text}, params={"profile": target.agent.id}))
    url = b.get("data_url") if isinstance(b, dict) else None
    if not isinstance(url, str) or not url.startswith("data:audio/") or len(url) > MAX_REPLY_CHARS:
        raise HTTPException(502, "Das Dashboard liefert keine brauchbare Audiodatei")
    return {"data_url": url, "mime_type": str(b.get("mime_type", ""))[:40], "provider": str(b.get("provider") or "")[:60]}


class TranscribeIn(BaseModel):
    model_config = {"extra": "forbid"}
    data_url: str = Field(max_length=2_000_000)
    mime_type: str | None = Field(default=None, max_length=60)

    @field_validator("data_url")
    @classmethod
    def _d(cls, v: str) -> str:
        m = UPLOAD.match(v)
        if not m:
            raise ValueError("Aufnahme: nur Base64-Audio (data:audio/...;base64,...)")
        try:
            raw = base64.b64decode(m.group(3), validate=True)
        except (binascii.Error, ValueError) as e:
            raise ValueError("Aufnahme: kein gültiges Base64") from e
        if len(raw) > MAX_AUDIO_BYTES:
            raise ValueError("Aufnahme: größer als 1,4 MB (etwa zwei Minuten)")
        return v

    @field_validator("mime_type")
    @classmethod
    def _m(cls, v: str | None) -> str | None:
        if v is not None and not MIME.match(v.split(";")[0].strip().lower()):
            raise ValueError("Typ: nur Audio")
        return v


@router.post("/hermes-voice/transcribe")
async def transcribe(request: Request, target: Tgt, dash: Dash, req: TranscribeIn, user: User = Depends(current_user)):
    _limit(request, user)
    body: dict[str, Any] = {"data_url": req.data_url, **({"mime_type": req.mime_type} if req.mime_type else {})}
    b = await upstream(dash.request("POST", "/api/audio/transcribe", body=body, params={"profile": target.agent.id}))
    if not isinstance(b, dict) or not isinstance(b.get("transcript"), str):
        raise HTTPException(502, "Das Dashboard liefert die Abschrift in unbekannter Form")
    return {"transcript": b["transcript"][:20000], "provider": str(b.get("provider") or "")[:60]}
