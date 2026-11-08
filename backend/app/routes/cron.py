"""Zeitpläne (Cron) und Logs über das Dashboard eines Hosts: lesen, anlegen, ändern, pausieren, ausführen, löschen.

Neue Zeitpläne entstehen immer pausiert. Audit nennt nur Job-ID und Profil, nie Prompt oder Zielwerte.
"""
from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request

from .. import cron as C
from ..adapters import UpstreamError
from ..auth import User, current_user, fresh_user
from ..registry import AGENT_RE, ID_RE
from ._dash import check_profile, dash, host_dash
from .agents import to_http

router = APIRouter(prefix="/bff", dependencies=[Depends(current_user)])
Host = Annotated[str, Path(pattern=ID_RE.pattern)]
Profile = Annotated[str, Path(pattern=AGENT_RE.pattern)]
JobId = Annotated[str, Path(pattern=C.JOB_RE)]
BASE = "/h/{host}/_cron/{profile}"
NOT_FOUND = "Zeitplan nicht gefunden"


def _audit(request: Request, user: User, action: str, host: str, profile: str, job: str | None = None) -> None:
    request.app.state.audit.record(action, user=user.id, target=host, profile=profile, **({"job": job} if job else {}))


async def _get(request: Request, host: str, profile: str, job_id: str) -> dict:
    return await dash(request, host, "GET", f"/api/cron/jobs/{job_id}", params={"profile": profile}, missing=NOT_FOUND)


async def _check_deliver(request: Request, host: str, profile: str, deliver: str | None) -> None:
    if deliver is None:
        return
    targets = C.targets_view(await dash(request, host, "GET", "/api/cron/delivery-targets", params={"profile": profile}))
    if deliver not in {t["id"] for t in targets}:
        raise HTTPException(422, "Unbekanntes Zustellziel: bitte eines aus der Liste wählen")


def _need_confirm(job: dict, confirmed: bool, what: str) -> None:
    if C.is_system(job) and not confirmed:
        raise HTTPException(409, f"Das ist ein System-Job (Skript ohne Agent). {what} nur mit ausdrücklicher Bestätigung.")


@router.get(BASE + "/schedules")
async def list_jobs(request: Request, host: Host, profile: Profile):
    return {"jobs": C.jobs_view(await dash(request, host, "GET", "/api/cron/jobs", params={"profile": profile})), "profile": profile}


@router.get(BASE + "/schedules/{job_id}")
async def get_job(request: Request, host: Host, profile: Profile, job_id: JobId):
    return C.job_view(await _get(request, host, profile, job_id))


@router.get(BASE + "/schedules/{job_id}/runs")
async def job_runs(request: Request, host: Host, profile: Profile, job_id: JobId, limit: int = Query(20, ge=1, le=100)):
    body = await dash(request, host, "GET", f"/api/cron/jobs/{job_id}/runs", params={"profile": profile, "limit": str(limit)}, missing=NOT_FOUND)
    return {"runs": C.runs_view(body)}


@router.post(BASE + "/schedules")
async def create_job(request: Request, host: Host, profile: Profile, req: C.JobCreate, user: User = Depends(fresh_user)):
    if req.creates_system() and not req.confirm_system:
        raise HTTPException(409, "Das ist ein Skript-Job ohne Agent und läuft direkt auf dem Server: Vorgang wiederholen und dabei ausdrücklich bestätigen")
    await _check_deliver(request, host, profile, req.deliver)
    body = {**req.model_dump(exclude_none=True, exclude={"confirm_system"}), "paused": True, "paused_reason": "Neu angelegt, bitte bewusst aktivieren"}  # neu = pausiert
    job = C.job_view(await dash(request, host, "POST", "/api/cron/jobs", body=body, params={"profile": profile}))
    _audit(request, user, "cron.create", host, profile, job["id"])
    return job


@router.put(BASE + "/schedules/{job_id}")
async def update_job(request: Request, host: Host, profile: Profile, job_id: JobId, req: C.JobUpdate, user: User = Depends(fresh_user)):
    updates = req.updates()
    if not updates:
        raise HTTPException(422, "Keine Änderung angegeben")
    _need_confirm(await _get(request, host, profile, job_id), req.confirm_system, "Ändern geht")
    await _check_deliver(request, host, profile, req.deliver)
    job = C.job_view(await dash(request, host, "PUT", f"/api/cron/jobs/{job_id}", body={"updates": updates}, params={"profile": profile}, missing=NOT_FOUND))
    _audit(request, user, "cron.update", host, profile, job_id)
    return job


@router.post(BASE + "/schedules/{job_id}/{action}")
async def job_action(request: Request, host: Host, profile: Profile, job_id: JobId, action: Literal["pause", "resume", "trigger"],
                     req: C.Confirmed = C.Confirmed(), user: User = Depends(fresh_user)):
    if action == "trigger":
        _need_confirm(await _get(request, host, profile, job_id), req.confirm_system, "Ausführen geht")
    job = C.job_view(await dash(request, host, "POST", f"/api/cron/jobs/{job_id}/{action}", params={"profile": profile}, missing=NOT_FOUND))
    _audit(request, user, f"cron.{action}", host, profile, job_id)
    return job


@router.delete(BASE + "/schedules/{job_id}")
async def delete_job(request: Request, host: Host, profile: Profile, job_id: JobId, req: C.Confirmed = C.Confirmed(), user: User = Depends(fresh_user)):
    _need_confirm(await _get(request, host, profile, job_id), req.confirm_system, "Löschen geht")
    await dash(request, host, "DELETE", f"/api/cron/jobs/{job_id}", params={"profile": profile}, missing=NOT_FOUND)
    _audit(request, user, "cron.delete", host, profile, job_id)
    return {"ok": True}


@router.get(BASE + "/targets")
async def targets(request: Request, host: Host, profile: Profile):
    return {"targets": C.targets_view(await dash(request, host, "GET", "/api/cron/delivery-targets", params={"profile": profile}))}


@router.get(BASE + "/blueprints")
async def blueprints(request: Request, host: Host, profile: Profile):
    return {"blueprints": C.blueprints_view(await dash(request, host, "GET", "/api/cron/blueprints", params={"profile": profile}))}


@router.post(BASE + "/blueprints")
async def instantiate(request: Request, host: Host, profile: Profile, req: C.Instantiate, user: User = Depends(fresh_user)):
    created = await dash(request, host, "POST", "/api/cron/blueprints/instantiate", body=req.model_dump(), params={"profile": profile})
    job = C.job_view(created if isinstance(created, dict) else {})
    if not job["id"]:
        raise HTTPException(502, "Das Dashboard lieferte keinen Zeitplan zurück")
    _audit(request, user, "cron.create", host, profile, job["id"])
    try:  # Vorlagen starten aktiv: sofort pausieren, damit neu = pausiert bleibt
        job = C.job_view(await dash(request, host, "POST", f"/api/cron/jobs/{job['id']}/pause", params={"profile": profile}, missing=NOT_FOUND))
    except HTTPException as e:
        # shortcut: Fenster zwischen Anlegen und Pausieren, weil der Dashboard-Endpunkt für Vorlagen kein "paused" kennt; ersetzen, sobald er es kennt
        try:
            await dash(request, host, "DELETE", f"/api/cron/jobs/{job['id']}", params={"profile": profile}, missing=NOT_FOUND)
        except HTTPException:
            raise HTTPException(502, f"Zeitplan {job['id']} wurde angelegt, ließ sich aber weder pausieren noch entfernen und ist aktiv: {e.detail}") from e
        _audit(request, user, "cron.delete", host, profile, job["id"])
        raise HTTPException(502, f"Zeitplan {job['id']} ließ sich nicht pausieren und wurde wieder entfernt: {e.detail}") from e
    return job


@router.get(BASE + "/skill-names")
async def skill_names(request: Request, host: Host, profile: Profile):
    check_profile(request, host, profile)
    try:
        rows = await host_dash(request, host).skills(profile)
    except UpstreamError as e:
        raise to_http(e) from e
    return {"skills": sorted({r["name"] for r in rows if isinstance(r.get("name"), str)})}


@router.get("/h/{host}/_logs")
async def logs(request: Request, host: Host, profile: Annotated[str | None, Query(pattern=AGENT_RE.pattern)] = None,
               file: Annotated[str, Query(pattern=r"^[a-z][a-z0-9_-]{0,31}$")] = "agent", lines: int = Query(200, ge=1, le=C.LOG_MAX_LINES),
               level: Literal[C.LOG_LEVELS] = "ALL", component: Literal[C.LOG_COMPONENTS] = "all",  # type: ignore[valid-type]
               search: Annotated[str, Query(max_length=200, pattern=C.NO_CONTROL)] = ""):
    params = {"file": file, "lines": str(lines), "level": level, "component": component, "search": search, **({"profile": profile} if profile else {})}
    body = await dash(request, host, "GET", "/api/logs", params={k: v for k, v in params.items() if v})
    try:
        return C.log_view(body)
    except ValueError as e:
        raise HTTPException(502, "Das Dashboard liefert Logs in unbekannter Form") from e
