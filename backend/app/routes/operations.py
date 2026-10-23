"""Authenticated host operations. Router registration belongs to app.main."""
from __future__ import annotations

import asyncio
import base64
import binascii
import json
import re
from typing import Annotated, Literal
from urllib.parse import quote, urlsplit

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, WebSocket
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from starlette.websockets import WebSocketDisconnect

from ..adapters.hermes import HermesAdapter
from ..auth import DEV_USER, SESSION_COOKIE, User, current_user, fresh_user, is_fresh
from ..operations import HostdClient, REVIEWED_SOURCES, UPLOAD_LIMIT, websocket_connect
from ..registry import AGENT_RE, ID_RE, HostCfg
from .agents import Tgt, audit, upstream

router = APIRouter(prefix="/bff")
HostId = Annotated[str, Path(pattern=ID_RE.pattern)]
ProfileId = Annotated[str, Path(pattern=AGENT_RE.pattern)]
ObjectId = Annotated[str, Path(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")]
JobId = Annotated[str, Path(pattern=r"^[a-f0-9]{12}$")]
Workspace = Annotated[str, Query(pattern=ID_RE.pattern)]
Kind = Literal["skills", "mcp", "plugins", "logs", "kanban"]


def host_cfg(request: Request, host: str) -> HostCfg:
    cfg = request.app.state.registry.host(host)
    if cfg is None:
        raise HTTPException(404, "Unbekannter Host")
    return cfg


def daemon(request: Request, host: str) -> HostdClient:
    cfg = host_cfg(request, host).hostd
    if cfg is None:
        raise HTTPException(503, "Kein Host-Dienst konfiguriert")
    return HostdClient(cfg, request.app.state.http)


def record(request, user: User, action: str, host: str):
    request.app.state.audit.record(action, user=user.id, target=host)


def safe_path(path: str) -> str:
    forbidden = {".git", ".ssh", ".aws", ".gnupg", ".hermes", "auth.json", "config.yaml", "config.yml",
                 "credentials", "credentials.json", "id_rsa", "id_ed25519"}
    parts = path.split("/") if path else []
    if (len(path) > 1024 or path.startswith("/") or "\\" in path or "%" in path
            or any(ord(c) < 32 or ord(c) == 127 for c in path)
            or any(p == "" or p == "." or p.startswith("..") or p.lower() in forbidden or p.lower().startswith(".env")
                   or p.lower().endswith((".pem", ".key")) for p in parts)):
        raise HTTPException(422, "Unsicherer Workspace-Pfad")
    return path


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class TerminalOpen(StrictModel):
    cli: str = Field(pattern=ID_RE.pattern)
    workspace: str = Field(pattern=ID_RE.pattern)
    cols: int = Field(80, ge=1, le=500)
    rows: int = Field(24, ge=1, le=200)


class Upload(StrictModel):
    workspace: str = Field(pattern=ID_RE.pattern)
    path: str = Field(min_length=1, max_length=1024)
    content_base64: str = Field(max_length=((UPLOAD_LIMIT + 2) // 3) * 4)

    @field_validator("path")
    @classmethod
    def validate_path(cls, value):
        return safe_path(value)

    @field_validator("content_base64")
    @classmethod
    def validate_content(cls, value):
        try:
            content = base64.b64decode(value, validate=True)
        except (ValueError, binascii.Error):
            raise ValueError("Ungültiges Base64") from None
        if len(content) > UPLOAD_LIMIT:
            raise ValueError("Datei größer als 1 MiB")
        return value


@router.get("/h/{host}/_hostd")
async def info(request: Request, host: HostId, _user: User = Depends(current_user)):
    host_cfg(request, host)
    try:
        result = await daemon(request, host).request("GET", "/v1/info")
        return {**result, "available": True, "reason": None}
    except HTTPException as exc:
        return {"available": False, "reason": exc.detail}


@router.get("/h/{host}/_terminals")
async def terminals(request: Request, host: HostId, _user: User = Depends(current_user)):
    return await daemon(request, host).request("GET", "/v1/terminals")


@router.post("/h/{host}/_terminals")
async def open_terminal(request: Request, host: HostId, body: TerminalOpen, user: User = Depends(fresh_user)):
    result = await daemon(request, host).request("POST", "/v1/terminals", body=body.model_dump())
    record(request, user, "terminal.open", host)
    return result


@router.delete("/h/{host}/_terminals/{terminal_id}")
async def close_terminal(request: Request, host: HostId, terminal_id: ObjectId, user: User = Depends(fresh_user)):
    result = await daemon(request, host).request("DELETE", f"/v1/terminals/{terminal_id}")
    record(request, user, "terminal.close", host)
    return result


@router.websocket("/h/{host}/_terminals/{terminal_id}/stream")
async def terminal_stream(ws: WebSocket, host: str, terminal_id: str):
    # HTTP middleware dependencies don't apply to WS: enforce every boundary before accept.
    settings = ws.app.state.settings
    try:
        raw_host = ws.headers.get("host", "")
        hostname = urlsplit("http://" + raw_host).hostname
        origin = ws.headers.get("origin", "")
        expected = settings.public_url.rstrip("/") or f"{'https' if ws.url.scheme == 'wss' else 'http'}://{raw_host}"
        if (not hostname or hostname not in settings.host_list() or origin != expected
                or urlsplit(origin).netloc != raw_host or not ID_RE.fullmatch(host)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", terminal_id)
                or set(ws.query_params) - {"after"}):
            raise ValueError("origin/host/path")
        after = int(ws.query_params.get("after", "0"))
        if not 0 <= after <= 2**63 - 1:
            raise ValueError("offset")
        session = ws.app.state.sessions.get(ws.cookies.get(SESSION_COOKIE))
        if settings.auth_mode != "none" and (session is None or not is_fresh(ws)):
            await ws.close(code=4401)
            return
        user = DEV_USER if settings.auth_mode == "none" else session.user
        cfg = ws.app.state.registry.host(host)
        if cfg is None or cfg.hostd is None:
            await ws.close(code=4404)
            return
    except (ValueError, TypeError):
        await ws.close(code=4403)
        return

    async def browser_to_daemon(remote):
        while True:
            raw = await ws.receive_text()
            if len(raw) > 96 * 1024:
                await ws.close(code=1009)
                return
            try:
                frame = json.loads(raw)
                if not isinstance(frame, dict):
                    raise ValueError
                if frame.get("type") == "input" and set(frame) == {"type", "data"}:
                    data = frame["data"]
                    if not isinstance(data, str) or len(base64.b64decode(data, validate=True)) > 16 * 1024:
                        raise ValueError
                elif frame.get("type") == "resize" and set(frame) == {"type", "cols", "rows"}:
                    if not (type(frame["cols"]) is int and 1 <= frame["cols"] <= 500
                            and type(frame["rows"]) is int and 1 <= frame["rows"] <= 200):
                        raise ValueError
                else:
                    raise ValueError
            except (ValueError, TypeError, binascii.Error):
                await ws.close(code=1008)
                return
            await remote.send(raw)

    async def daemon_to_browser(remote):
        async for frame in remote:
            if not isinstance(frame, str):
                await ws.close(code=1008)
                return
            # Terminal text is opaque and never logged or written to audit.
            await ws.send_text(frame)

    accepted = False
    try:
        async with websocket_connect(cfg.hostd, terminal_id, after) as remote:
            await ws.accept()
            accepted = True
            record(ws, user, "terminal.attach", host)
            tasks = [asyncio.create_task(browser_to_daemon(remote)), asyncio.create_task(daemon_to_browser(remote))]
            try:
                done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
    except WebSocketDisconnect:
        pass
    except Exception:
        # Exceptions may contain upstream URLs/headers. Never expose or log them.
        if not accepted:
            await ws.close(code=1011)
    finally:
        if accepted:
            record(ws, user, "terminal.detach", host)
            try:
                await ws.close()
            except RuntimeError:
                pass


@router.get("/h/{host}/_workspaces")
async def workspaces(request: Request, host: HostId, _user: User = Depends(current_user)):
    return await daemon(request, host).request("GET", "/v1/workspaces")


@router.get("/h/{host}/_files")
async def files(request: Request, host: HostId, workspace: Workspace, path: str = "", _user: User = Depends(current_user)):
    return await daemon(request, host).request("GET", "/v1/files", params={"workspace": workspace, "path": safe_path(path)})


@router.get("/h/{host}/_files/download")
async def download(request: Request, host: HostId, workspace: Workspace, path: str, _user: User = Depends(current_user)):
    safe_path(path)
    if not path or path.endswith("/"):
        raise HTTPException(422, "Dateipfad fehlt")
    content = await daemon(request, host).request("GET", "/v1/files/download",
                params={"workspace": workspace, "path": path}, download=True)
    return Response(content, media_type="application/octet-stream", headers={
        "Content-Disposition": "attachment; filename*=UTF-8''" + quote(path.split("/")[-1], safe=""),
        "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox"})


@router.post("/h/{host}/_files/upload")
async def upload(request: Request, host: HostId, body: Upload, user: User = Depends(fresh_user)):
    result = await daemon(request, host).request("POST", "/v1/files/upload", body=body.model_dump())
    record(request, user, "workspace.upload", host)
    return result


@router.get("/h/{host}/_git")
async def git(request: Request, host: HostId, workspace: Workspace, _user: User = Depends(current_user)):
    return await daemon(request, host).request("GET", "/v1/git", params={"workspace": workspace})


@router.get("/search")
async def search(request: Request, q: str = Query(min_length=1, max_length=200), _user: User = Depends(current_user)):
    if not q.strip():
        raise HTTPException(422, "Suchtext fehlt")
    hosts = request.app.state.registry.hosts()
    semaphore = asyncio.Semaphore(4)

    async def one(host):
        async with semaphore:
            try:
                return await daemon(request, host.id).request("GET", "/v1/search", params={"q": q})
            except HTTPException as exc:
                return {"warning": exc.detail}
    batches = await asyncio.gather(*(one(h) for h in hosts))
    results, warnings, truncated = [], [], False
    for host, batch in zip(hosts, batches, strict=True):
        if "warning" in batch or "reason" in batch:
            warnings.append({"host": host.id, "reason": batch.get("warning", batch.get("reason"))})
        rows = batch.get("results", [])
        if not isinstance(rows, list):
            warnings.append({"host": host.id, "reason": "Ungültige Suchantwort"})
            continue
        truncated |= bool(batch.get("truncated"))
        for row in rows:
            if not isinstance(row, dict) or not all(isinstance(row.get(k), str) for k in ("profile", "session_id", "title", "snippet")):
                warnings.append({"host": host.id, "reason": "Ungültiger Suchtreffer"})
                continue
            if len(results) >= 200:
                truncated = True
                break
            results.append({"host": host.id, **{k: row[k][:4000] for k in ("profile", "session_id", "title", "snippet")}})
    return {"results": results, "warnings": warnings, "truncated": truncated}


@router.get("/h/{host}/_manage")
async def manage(request: Request, host: HostId, _user: User = Depends(current_user)):
    result = await daemon(request, host).request("GET", "/v1/manage")
    sources = list(REVIEWED_SOURCES)
    # Host-owned reviewed catalog exposes identifiers, never an install URL accepted from the browser.
    for source in result.get("sources", []):
        if not isinstance(source, dict) or source.get("reviewed") is not True:
            continue
        try:
            url = urlsplit(source.get("url", ""))
            if (url.scheme != "https" or not url.hostname or url.username or url.password
                    or url.query or url.fragment):
                continue
        except (ValueError, TypeError):
            continue
        sources.append({**source, "installable": source.get("kind") == "plugins",
                        "trust": "Host administrator reviewed this identifier; native profile allowlist and consent still apply."})
    return {**result, "sources": sources}


@router.get("/h/{host}/_manage/{profile}/{kind}")
async def management(request: Request, host: HostId, profile: ProfileId, kind: Kind, _user: User = Depends(current_user)):
    return await daemon(request, host).request("GET", f"/v1/manage/{profile}/{kind}")


class ManagementWrite(StrictModel):
    id: str = Field(min_length=1, max_length=101, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]*$")


@router.post("/h/{host}/_manage/{profile}/{kind}/{action}")
async def management_write(request: Request, host: HostId, profile: ProfileId, kind: Kind,
                           action: str, body: ManagementWrite, user: User = Depends(fresh_user)):
    # Native CLI only supports these non-interactive operations; daemon enforces reviewed IDs.
    if kind != "plugins" or action not in ("enable", "disable", "install"):
        raise HTTPException(404, "Nicht freigegebene Verwaltungsaktion")
    result = await daemon(request, host).request("POST", f"/v1/manage/{profile}/{kind}/{action}", body=body.model_dump())
    record(request, user, f"manage.{kind}.{action}", host)
    return result


class JobWrite(StrictModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    schedule: str | None = Field(None, min_length=1, max_length=200)
    prompt: str | None = Field(None, max_length=5000)
    deliver: Literal["local"] = "local"
    skills: list[Annotated[str, Field(min_length=1, max_length=128)]] | None = Field(None, max_length=30)
    repeat: int | None = Field(None, ge=1, le=1000000)
    enabled: bool | None = None


def hermes(target):
    if not isinstance(target.adapter, HermesAdapter):
        raise HTTPException(501, "Jobs werden für diese Runtime nicht unterstützt")
    return target.adapter


async def job_request(request, target, method, suffix="", body=None, user=None):
    adapter = hermes(target)
    if method != "GET":
        caps = await upstream(adapter._request("GET", target.agent.id, "/v1/capabilities"))
        if not isinstance(caps, dict) or caps.get("features", {}).get("jobs_admin") is not True:
            raise HTTPException(501, "Runtime gibt Jobs-Schreibzugriff nicht frei")
    result = await upstream(adapter._request(method, target.agent.id, "/api/jobs" + suffix,
                                            **({"json": body} if body is not None else {})))
    if user:
        audit(request, user, "jobs." + method.lower(), target)
    return result


@router.get("/h/{host}/{runtime}/{agent}/jobs")
async def jobs(request: Request, target: Tgt, include_disabled: bool = True, _user: User = Depends(current_user)):
    return await upstream(hermes(target)._request("GET", target.agent.id, "/api/jobs", params={"include_disabled": str(include_disabled).lower()}))


@router.get("/h/{host}/{runtime}/{agent}/jobs/{job_id}")
async def job(request: Request, target: Tgt, job_id: JobId, _user: User = Depends(current_user)):
    return await job_request(request, target, "GET", "/" + job_id)


@router.post("/h/{host}/{runtime}/{agent}/jobs")
async def create_job(request: Request, target: Tgt, body: JobWrite, user: User = Depends(fresh_user)):
    if not body.name or not body.name.strip() or not body.schedule or not body.schedule.strip() or body.enabled is not None:
        raise HTTPException(422, "Name/Schedule erforderlich; Aktivierung separat über Resume")
    # Creating a schedule must not implicitly start execution. Only explicit Resume enables it.
    data = body.model_dump(exclude_none=True)
    data.update(paused=True, paused_reason="Created paused via WebUI; explicit resume required", deliver="local")
    return await job_request(request, target, "POST", body=data, user=user)


@router.patch("/h/{host}/{runtime}/{agent}/jobs/{job_id}")
async def update_job(request: Request, target: Tgt, job_id: JobId, body: JobWrite, user: User = Depends(fresh_user)):
    data = body.model_dump(exclude_unset=True, exclude_none=True)
    if not data:
        raise HTTPException(422, "Keine Änderungen")
    return await job_request(request, target, "PATCH", "/" + job_id, body=data, user=user)


@router.delete("/h/{host}/{runtime}/{agent}/jobs/{job_id}")
async def delete_job(request: Request, target: Tgt, job_id: JobId, user: User = Depends(fresh_user)):
    return await job_request(request, target, "DELETE", "/" + job_id, user=user)


@router.post("/h/{host}/{runtime}/{agent}/jobs/{job_id}/{action}")
async def change_job(request: Request, target: Tgt, job_id: JobId, action: str, user: User = Depends(fresh_user)):
    if action not in ("pause", "resume"):
        raise HTTPException(404, "Nicht freigegebene Job-Aktion")
    return await job_request(request, target, "POST", f"/{job_id}/{action}", body={}, user=user)
