from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from ..auth import current_user
from ..ui import NAME_RE

router = APIRouter(prefix="/bff/ui", dependencies=[Depends(current_user)])

# Eigene Richtlinie für Bilder: selbst bei direktem Aufruf darf nichts laden oder laufen.
SVG_HEADERS = {"Content-Security-Policy": "default-src 'none'; style-src 'none'; sandbox"}


def _svg(request: Request, key: str) -> Response:
    svg = request.app.state.ui.svg(key)
    if svg is None:
        raise HTTPException(404)
    return Response(svg, media_type="image/svg+xml", headers=SVG_HEADERS)


@router.get("")
async def ui_config(request: Request):
    """Sigils, Shader-Einstellung und Hinweise aus ui.json. Ohne Datei gelten die Standardwerte."""
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
