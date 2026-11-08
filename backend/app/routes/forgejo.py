"""Forgejo-Issues: /bff/forgejo/<instanz>/… Lesen für Angemeldete, Schreiben nur mit frischer Anmeldung (Step-up) und im Audit (ohne Text)."""
from __future__ import annotations

import os
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from ..auth import User, current_user, fresh_user
from ..forgejo import ID_RE, LABEL_RE, REPO_RE, ForgejoClient
from .memory import upstream

router = APIRouter(prefix="/bff/forgejo")
InstId = Annotated[str, Path(pattern=ID_RE.pattern)]
Repo = Annotated[str, Query(pattern=REPO_RE.pattern, max_length=201)]
Number = Annotated[int, Path(ge=1, le=10_000_000)]
Login = Annotated[str, Field(pattern=r"^([A-Za-z0-9][A-Za-z0-9_.-]{0,99})?$")]
Label = Annotated[str, Field(pattern=LABEL_RE.pattern)]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class NewIssue(Strict):
    title: Annotated[str, Field(min_length=1, max_length=255)]
    body: Annotated[str, Field(max_length=100_000)] = ""
    assignee: Login = ""
    labels: list[Label] = Field(default_factory=list, max_length=20)


class IssuePatch(Strict):
    title: Annotated[str, Field(min_length=1, max_length=255)] | None = None
    body: Annotated[str, Field(max_length=100_000)] | None = None
    assignee: Login | None = None
    column: Annotated[str, Field(min_length=1, max_length=100)] | None = None
    labels: list[Label] | None = Field(None, max_length=20)


class NewComment(Strict):
    body: Annotated[str, Field(min_length=1, max_length=65_000)]


def client_of(request: Request, inst: InstId) -> ForgejoClient:
    cfg = request.app.state.forgejo.instances().get(inst)
    if cfg is None:
        raise HTTPException(404, "Unbekannte Forgejo-Instanz")
    return ForgejoClient(cfg, request.app.state.http)


def checked(c: ForgejoClient, repo: str) -> str:
    if repo not in c.cfg.repos:
        raise HTTPException(404, "Dieses Repo ist nicht freigegeben")
    return repo


Cl = Annotated[ForgejoClient, Depends(client_of)]


def _rec(request: Request, user: User, action: str, inst: str, repo: str, number: int | None = None, **detail) -> None:
    request.app.state.audit.record(action, user=user.id, target=f"{inst}:{repo}" + (f"#{number}" if number else ""), **detail)


@router.get("")
async def list_instances(request: Request, user: User = Depends(current_user)):
    reg = request.app.state.forgejo
    return {"instances": [{"id": c.id, "label": c.label, "base_url": c.base_url, "repos": list(c.repos), "columns": c.columns,
                           "token_set": bool(os.environ.get(c.token_env, "").strip())} for c in reg.instances().values()],
            "config_error": reg.error}


@router.get("/{inst}/issues")
async def issues(c: Cl, repo: Repo, state: Annotated[str, Query(pattern="^(open|closed|all)$")] = "all", user: User = Depends(current_user)):
    items, truncated = await upstream(c.issues(checked(c, repo), state))
    return {"issues": items, "truncated": truncated, "columns": c.cfg.columns}


@router.get("/{inst}/labels")
async def labels(c: Cl, repo: Repo, user: User = Depends(current_user)):
    return {"labels": await upstream(c.labels(checked(c, repo)))}


@router.get("/{inst}/issues/{number}")
async def issue(c: Cl, repo: Repo, number: Number, user: User = Depends(current_user)):
    return await upstream(c.issue(checked(c, repo), number))


@router.post("/{inst}/issues", status_code=201)
async def create_issue(request: Request, inst: InstId, c: Cl, repo: Repo, body: NewIssue, user: User = Depends(fresh_user)):
    out = await upstream(c.create(checked(c, repo), body.title, body.body, body.assignee or None, body.labels))
    _rec(request, user, "forgejo.issue.create", inst, repo, out.get("number"))
    return out


@router.patch("/{inst}/issues/{number}")
async def patch_issue(request: Request, inst: InstId, c: Cl, repo: Repo, number: Number, body: IssuePatch, user: User = Depends(fresh_user)):
    data = body.model_dump(exclude_none=True)
    if not data:
        raise HTTPException(422, "Nichts zu ändern")
    out = await upstream(c.update(checked(c, repo), number, title=body.title, body=body.body, assignee=body.assignee, column=body.column, labels=body.labels))
    _rec(request, user, "forgejo.issue.update", inst, repo, number, fields=sorted(data))
    return out


@router.post("/{inst}/issues/{number}/comments", status_code=201)
async def comment_issue(request: Request, inst: InstId, c: Cl, repo: Repo, number: Number, body: NewComment, user: User = Depends(fresh_user)):
    await upstream(c.comment(checked(c, repo), number, body.body))
    _rec(request, user, "forgejo.issue.comment", inst, repo, number)
    return {"ok": True}
