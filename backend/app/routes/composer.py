"""Chat-Eingabe: Befehlsliste, @-Bezüge expandieren, Skill-Anweisung bauen. Das BFF holt nie fremde URLs."""
from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from pydantic import BaseModel, ConfigDict, Field

from .. import composer
from ..auth import User, current_user
from ..registry import ID_RE
from ._dash import dash
from .agents import Tgt, audit
from .operations import daemon

router = APIRouter(prefix="/bff", dependencies=[Depends(current_user)])
HostId = Annotated[str, Path(pattern=ID_RE.pattern)]
SKILL_RE = r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ExpandRequest(StrictModel):
    workspace: str | None = Field(default=None, pattern=ID_RE.pattern)
    text: str = Field(min_length=1, max_length=100_000)


class SkillRequest(StrictModel):
    name: str = Field(pattern=SKILL_RE)
    instruction: str = Field(default="", max_length=50_000)


@router.get("/h/{host}/{runtime}/{agent}/_commands")
async def commands(target: Tgt):
    return {"source": "hermes_cli/commands.py (Schnappschuss)", "commands": composer.slash_commands()}


@router.post("/h/{host}/_composer/expand")
async def expand(request: Request, host: HostId, req: ExpandRequest, user: User = Depends(current_user)):
    async def fetch(path: str, params: dict[str, Any]) -> dict[str, Any]:
        return await daemon(request, host).request("GET", path, params=params)

    result = await composer.expand(req.text, req.workspace, fetch)
    kinds = sorted({r["kind"] for r in result["refs"]})
    # nur Zahlen und Arten, nie Inhalte
    request.app.state.audit.record("composer.expand", user=user.id, target=host, refs=len(result["refs"]), kinds=",".join(kinds), tokens=result["tokens"])
    return result


@router.post("/h/{host}/{runtime}/{agent}/_skill")
async def skill(request: Request, target: Tgt, host: HostId, req: SkillRequest, user: User = Depends(current_user)):
    """`/skill-name Anweisung` wird wie in Hermes zur Skill-Anweisung. Den Text liefert das Dashboard des Hosts."""
    data = await dash(request, host, "GET", "/api/skills/content", params={"name": req.name, "profile": target.agent.id})
    content = data.get("content") if isinstance(data, dict) else None
    if not isinstance(content, str) or not content.strip():
        raise HTTPException(404, "Skill nicht gefunden oder ohne Inhalt")
    audit(request, user, "composer.skill", target, skill=req.name, chars=len(req.instruction))
    return {"text": composer.skill_message(req.name, content, req.instruction)}
