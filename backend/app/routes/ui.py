from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from ..auth import User, current_user
from ..security import client_ip
from ..ui import LABEL_MAX, MAX_SVG_BYTES, NAME_RE, UiWriteError

router = APIRouter(prefix="/bff/ui", dependencies=[Depends(current_user)])
CurrentUser = Annotated[User, Depends(current_user)]

# Eigene Richtlinie für Bilder: selbst bei direktem Aufruf darf nichts laden oder laufen.
SVG_HEADERS = {"Content-Security-Policy": "default-src 'none'; style-src 'none'; sandbox"}


def _svg(request: Request, key: str) -> Response:
    svg = request.app.state.ui.svg(key)
    if svg is None:
        raise HTTPException(404)
    return Response(svg, media_type="image/svg+xml", headers=SVG_HEADERS)


@router.get("")
async def ui_config(request: Request):
    """Sigils, Namen, Packs, Shader-Einstellung und Hinweise aus ui.json. Ohne Datei gelten die Standardwerte."""
    return request.app.state.ui.public()


@router.get("/sigils/{name}.svg")
async def sigil_svg(request: Request, name: str):
    if not NAME_RE.match(name):
        raise HTTPException(404)
    return _svg(request, f"sigil/{name}")


@router.get("/glyphs/{pack}/{name}.svg")
async def glyph_svg(request: Request, pack: str, name: str):
    if not (NAME_RE.match(pack) and NAME_RE.match(name)):
        raise HTTPException(404)
    return _svg(request, f"glyph/{pack}/{name}")


# --- Speichern (Profil-Seite, Darstellung) ---------------------------------------------------------
class SigilIn(BaseModel):
    type: Literal["glyph", "initials", "svg"]
    glyph: str | None = Field(None, max_length=130)
    text: str | None = Field(None, max_length=3)
    hue: float | Literal["auto"] | None = "auto"  # null heißt neutral (grau)
    svg: str | None = Field(None, max_length=MAX_SVG_BYTES * 2)  # neue Datei als Text; der Server bereinigt sie


class ProfileIn(BaseModel):
    label: str | None = Field(None, max_length=LABEL_MAX * 2)
    sigil: SigilIn | None = None


class ShaderIn(BaseModel):
    enabled: bool
    strength: float = Field(ge=0, le=3)
    speed: float = Field(ge=0, le=3)


def _audit(request: Request, user: User, action: str, target: str, outcome: str = "ok", **detail: object) -> None:
    ip = client_ip(request, request.app.state.settings)
    request.app.state.audit.record(action, user=user.id, ip=ip, target=target, outcome=outcome, **detail)


@router.put("/profiles/{key:path}")
def save_profile(request: Request, key: str, body: ProfileIn, user: CurrentUser):
    """Anzeigename und Sigil eines Profils in ui.json schreiben. Beides leer entfernt den Eintrag."""
    ui = request.app.state.ui
    sigil = body.sigil.model_dump(exclude={"svg"}) if body.sigil else None
    try:
        ui.save_profile(key, body.label, sigil, body.sigil.svg if body.sigil else None)
    except UiWriteError as e:
        _audit(request, user, "ui.profile", key, outcome="error", reason=str(e))
        raise HTTPException(e.status, str(e)) from e
    _audit(request, user, "ui.profile", key, sigil=sigil["type"] if sigil else None, label=bool(body.label))
    return ui.public()


@router.put("/shader")
def save_shader(request: Request, body: ShaderIn, user: CurrentUser):
    """Standardwerte des Hintergrund-Shaders in ui.json schreiben (für alle Geräte)."""
    ui = request.app.state.ui
    try:
        ui.save_shader(body.enabled, body.strength, body.speed)
    except UiWriteError as e:
        _audit(request, user, "ui.shader", "backgroundShader", outcome="error", reason=str(e))
        raise HTTPException(e.status, str(e)) from e
    _audit(request, user, "ui.shader", "backgroundShader", enabled=body.enabled, strength=body.strength, speed=body.speed)
    return ui.public()
