"""Profil-Lebenszyklus (Punkt 4) und Betrieb (Punkt 5) eines Agents.

Hermes sichert serverseitig wenig. Das BFF setzt die Schranken selbst: Name gegen dieselbe Regel wie Hermes (klein, kein reservierter Name, sonst
422 bevor etwas reist), Klonen ohne Bot-Tokens außer auf Wunsch, Löschen und Backup nur nach Namenseingabe, Import als Upload aus dem Browser
als Serverpfad: der Browser liefert die Bytes, das BFF schreibt sie in eine temp-Datei auf dem Dashboard-Rechner und meldet danach den Pfad
weiter; freie Pfade nimmt es nie an. Beschreibung kurz, Archiv-Hinweise nur als Pfad. Absichtlich fehlen und bleiben 404: roher Backup-Download,
Update, `config-migrate`, `dump`, `prompt-size`, `debug-share`, Setup-Start. Aktions-Logs werden mit `redact` geschwärzt.
"""
from __future__ import annotations

import re
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Path, Request, UploadFile
from pydantic import BaseModel, Field

from ..auth import User, current_user, fresh_user
from ..dashboard_ops import clip, redact
from .agents import Tgt, upstream
from .agents import Target
from .dashboard import Dash, audit

router = APIRouter(prefix="/bff/h/{host}/{runtime}/{agent}", dependencies=[Depends(current_user)])

DEFAULT, DOCTOR = "default", "doctor"  # feste Namen; als f-String, damit check_upstream die Route als {name}-Muster kennt

Name = Annotated[str, Path(pattern=r"^[a-z0-9][a-z0-9_-]{0,63}$")]
RESERVED = {"hermes", "default", "test", "tmp", "root", "sudo"}
OK = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def canon(name: str) -> str:
    """Wie Hermes `normalize_profile_name` (Namen sind case-insensitiv): gestutzt, klein, nur Kleinbuchstaben, kein reservierter Name, sonst 422."""
    raw = (name or "").strip()
    if raw != raw.lower():
        raise HTTPException(422, "Name: nur Kleinbuchstaben (Hermes behandelt Namen case-insensitiv)")
    out = raw.lower()
    if not out or len(out) > 64 or not OK.fullmatch(out) or out in RESERVED:
        raise HTTPException(422, "Name: klein, Ziffern, - oder _, kein reservierter Name (hermes, default, test, tmp, root, sudo)")
    return out


class CreateIn(BaseModel):
    name: str = Field(max_length=80)
    description: str | None = Field(default=None, max_length=300)
    clone_from: str | None = Field(default=None, max_length=80)
    clone_channels: bool = False


class RenameIn(BaseModel):
    new_name: str = Field(max_length=80)


class ConfirmIn(BaseModel):
    confirm: str = ""


class OpsConfirmIn(BaseModel):
    model_config = {"extra": "forbid"}
    confirm: str = ""


class ImportName(BaseModel):
    model_config = {"extra": "forbid"}
    name: str | None = Field(default=None, max_length=80)


LIMIT = 50 * 1024 * 1024


def _limit(request: Request, user: User, what: str) -> None:
    request.app.state.limiter.check(f"{user.id}:{what}")


def already_running(names: set[str], staging: dict[str, str]) -> None:
    for n, aid in staging.items():
        if n in names:
            raise HTTPException(409, f"{n} wird gerade angelegt")


STAGING: dict[str, str] = {}


@router.get("/hermes-profiles")
async def profiles(target: Tgt, dash: Dash):
    try:
        act = await upstream(dash.request("GET", "/api/profiles/active"))
    except HTTPException as e:
        if e.status_code == 404:
            act = {}
        else:
            raise
    active = act.get("active") if isinstance(act, dict) else None
    body = await upstream(dash.request("GET", "/api/profiles"))
    rows = body.get("profiles") if isinstance(body, dict) else None
    if not isinstance(rows, list):
        raise HTTPException(502, "Das Dashboard liefert die Profile in einer unbekannten Form")
    out = []
    for p in rows:
        if not isinstance(p, dict) or not isinstance(p.get("name"), str):
            continue
        out.append({"name": p["name"], "is_default": bool(p.get("is_default", p["name"] == "default")),
                    "model": p.get("model"), "provider": p.get("provider"), "gateway_running": bool(p.get("gateway_running")),
                    "skill_count": p.get("skill_count") if isinstance(p.get("skill_count"), int) else None,
                    "description": clip(p.get("description"), 300), "description_auto": bool(p.get("description_auto"))})
    return {"profiles": out, "active": active}


@router.post("/hermes-profiles", status_code=201)
async def create(request: Request, target: Tgt, dash: Dash, req: CreateIn, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-profiles")
    name = canon(req.name)
    src = canon(req.clone_from) if req.clone_from else None
    if src and req.clone_from and req.clone_from.strip().lower() in RESERVED:
        raise HTTPException(422, "Quelle: unbekanntes Profil")
    already_running({name}, STAGING)
    payload: dict[str, Any] = {"name": name}
    if src:
        payload["clone_from"] = src
    if req.clone_channels:
        payload["clone_channels"] = True
    try:
        result = await upstream(dash.request("POST", "/api/profiles", body=payload))
    except HTTPException as e:
        text = e.detail if isinstance(e.detail, str) else ""
        if e.status_code == 502 and "exist" in text.lower():
            raise HTTPException(409, "Dieses Profil gibt es schon")
        if e.status_code == 404 or (e.status_code == 502 and "Quelle fehlt" in text):
            raise HTTPException(422, "Quelle: unbekanntes Profil")
        raise
    got = result.get("name") if isinstance(result, dict) else None
    if got != name:
        raise HTTPException(502, "Das Dashboard hat das Profil nicht wie erwartet angelegt")
    desc = (req.description or "").strip()
    if desc:
        await upstream(dash.request("PUT", f"/api/profiles/{name}/description", body={"description": desc[:300]}, params={"profile": name}))
    audit(request, user, "hermes_profile.create", target, profile=name, clone_from=src or "", clone_channels=req.clone_channels)
    return {"ok": True, "name": name, "setup": "Einrichtung: hermes setup"}


@router.patch("/hermes-profiles/{name}")
async def rename(request: Request, name: Name, target: Tgt, dash: Dash, req: RenameIn, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-profiles")
    new = canon(req.new_name)
    result = await upstream(dash.request("PATCH", f"/api/profiles/{name}", body={"new_name": new}, params={"profile": name}, missing="Dieses Profil gibt es nicht"))
    got = result.get("name") if isinstance(result, dict) else None
    if got != new:
        raise HTTPException(502, "Das Dashboard hat nicht wie erwartet umbenannt")
    audit(request, user, "hermes_profile.rename", target, profile=name, new_name=new)
    return {"ok": True, "name": got}


@router.delete("/hermes-profiles/{name}")
async def delete(request: Request, name: Name, target: Tgt, dash: Dash, req: ConfirmIn | None = None, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-profiles")
    confirm = (req.confirm if req else "")
    if confirm != name:
        raise HTTPException(422, f"Zum Bestätigen „{name}“ eintippen. Das Löschen ist endgültig.")
    result = await upstream(dash.request("DELETE", f"/api/profiles/{name}", body={"confirm": name}, params={"profile": name}, missing="Dieses Profil gibt es nicht"))
    stopped = bool(result.get("gateway_stopped")) if isinstance(result, dict) else False
    after = await upstream(dash.request("GET", "/api/profiles"))
    rows = after.get("profiles") if isinstance(after, dict) else []
    if any(isinstance(p, dict) and p.get("name") == name for p in rows or []):
        raise HTTPException(502, "Das Dashboard hat nicht gelöscht")
    audit(request, user, "hermes_profile.delete", target, profile=name)
    return {"ok": True, "name": name, "gateway_stopped": stopped}


@router.post("/hermes-profiles/import", status_code=201)
async def import_upload(request: Request, target: Tgt, dash: Dash, archive: UploadFile = File(...), name: str | None = Form(default=None), user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-profiles")
    want = canon(name) if name else None
    data = await archive.read()
    if len(data) > LIMIT:
        raise HTTPException(413, "Das Archiv ist zu groß (max. 50 MB)")
    fname = (archive.filename or "").lower()
    if not fname.endswith((".tar.gz", ".tgz", ".zip")) or not (data[:2] == b"PK" or data[:2] == b"\x1f\x8b"):
        raise HTTPException(422, "Nur .tar.gz oder .zip aus dem Dateidialog")
    already_running({want} if want else set(), STAGING)
    import os
    import tempfile
    fd, tmp_name = tempfile.mkstemp(suffix=".tar.gz")
    try:
        with os.fdopen(fd, "wb") as tmp:
            tmp.write(data)
        result = await upstream(dash.request("POST", "/api/profiles/import", body={"archive": tmp_name, **({"name": want} if want else {})}))
    finally:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
    got = result.get("name") if isinstance(result, dict) else None
    if not got or (want and got != want):
        raise HTTPException(502, "Das Dashboard hat den Import nicht wie erwartet angelegt")
    audit(request, user, "hermes_profile.import", target, profile=got)
    return {"ok": True, "name": got}


@router.post("/hermes-profiles/{name}/export")
async def export(request: Request, name: Name, target: Tgt, dash: Dash, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-profiles")
    result = await upstream(dash.request("POST", f"/api/profiles/{name}/export", body={}, params={"profile": name}, missing="Dieses Profil gibt es nicht"))
    archive = result.get("archive") if isinstance(result, dict) else None
    if not isinstance(archive, str) or not archive.endswith(".tar.gz") or ".." in archive or "\n" in archive:
        raise HTTPException(502, "Das Dashboard liefert keinen gültigen Archivpfad")
    audit(request, user, "hermes_profile.export", target, profile=name)
    return {"ok": True, "name": name, "archive": archive, "note": "Der Export landet auf dem Rechner des Agents; Zugangsdaten sind laut Hermes ausgenommen."}


@router.get("/hermes-profiles/setup-command")
async def setup_command(target: Tgt, dash: Dash):
    result = await upstream(dash.request("GET", f"/api/profiles/{DEFAULT}/setup-command"))
    cmd = result.get("command") if isinstance(result, dict) else None
    if not isinstance(cmd, str) or not cmd:
        raise HTTPException(502, "Das Dashboard liefert keinen Setup-Befehl")
    return {"command": cmd[:200], "scope": "dashboard-home", "note": "Gilt für das Heim des Dashboards, nicht für ein einzelnes Profil."}


Active = Annotated[str, Path(pattern=r"^[a-z0-9][a-z0-9_-]{0,63}$")]


@router.get("/hermes-ops/status")
async def ops_status(target: Tgt, dash: Dash):
    body = await upstream(dash.request("GET", "/api/status"))
    if not isinstance(body, dict) or not isinstance(body.get("version"), str):
        raise HTTPException(502, "Das Dashboard liefert den Status in einer unbekannten Form")
    return {"profile": body.get("profile") or target.agent, "version": "Hermes " + body["version"], "ok": bool(body.get("ok", True))}


@router.get("/hermes-ops/health")
async def ops_health(target: Tgt, dash: Dash):
    body = await upstream(dash.request("GET", "/api/health"))
    if not isinstance(body, dict):
        raise HTTPException(502, "Das Dashboard liefert die Gesundheit in einer unbekannten Form")
    return {"ok": bool(body.get("ok", True)), "uptime_s": body.get("uptime_s") if isinstance(body.get("uptime_s"), int) else None}


@router.get("/hermes-ops/update-check")
async def ops_update_check(target: Tgt, dash: Dash):
    body = await upstream(dash.request("GET", "/api/hermes/update/check"))
    if not isinstance(body, dict) or not body.get("current"):
        raise HTTPException(502, "Das Dashboard liefert die Update-Prüfung in einer unbekannten Form")
    return {"current": str(body["current"])[:100], "available": str(body["available"])[:100] if body.get("available") else None}


@router.post("/hermes-ops/doctor", status_code=202)
async def ops_start(request: Request, target: Tgt, dash: Dash, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-ops")
    await upstream(dash.request("POST", "/api/ops/doctor", params={"profile": target.agent.id}))
    audit(request, user, "hermes_ops.doctor", target)
    return {"ok": True, "action": "doctor", "note": "Läuft im Hintergrund; Zustand und Protokoll unten."}


@router.get("/hermes-ops/actions/doctor")
async def ops_action(target: Tgt, dash: Dash):
    body = await upstream(dash.request("GET", f"/api/actions/{DOCTOR}/status"))
    if not isinstance(body, dict):
        raise HTTPException(502, "Das Dashboard liefert den Aktionszustand in einer unbekannten Form")
    return {"action": "doctor", "running": bool(body.get("running")), "exit_code": body.get("exit_code") if isinstance(body.get("exit_code"), int) else None, "log": redact(str(body.get("log") or ""))[-4000:]}


@router.post("/hermes-ops/backup")
async def ops_backup(request: Request, target: Tgt, dash: Dash, req: OpsConfirmIn, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-ops")
    if req.confirm != target.agent.id:
        raise HTTPException(422, "Zum Bestätigen die Agenten-ID eintippen. Das Backup enthält Zugangsdaten.")
    result = await upstream(dash.request("POST", "/api/ops/backup", body={}, params={"profile": target.agent.id}))
    archive = result.get("archive") if isinstance(result, dict) else None
    if not isinstance(archive, str) or not archive.endswith(".zip") or ".." in archive or "\n" in archive:
        raise HTTPException(502, "Das Dashboard liefert keinen gültigen Backup-Pfad")
    audit(request, user, "hermes_ops.backup", target)
    return {"ok": True, "archive": archive, "contains_secrets": True, "note": "Das Archiv liegt auf dem Rechner des Agents und enthält Zugangsdaten."}
