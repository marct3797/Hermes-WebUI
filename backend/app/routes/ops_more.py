"""Etappe 1 der Abdeckung: Betrieb und Konfiguration, soweit Hermes dafür eine Dashboard-Route anbietet.

Lesen: Checkpoints (nur Sitzungs-ID, Dateizahl, Größe; nie Pfade), Update-Beleg (Kurzfassung), Standardwerte und Roh-YAML der Konfiguration
(Geheimnisse und Serverpfade entfallen). Schreiben, jeweils mit frischer Anmeldung und eingetippter Bestätigung: Checkpoints aufräumen,
Sicherheitsprüfung starten, Gateway leeren (Drain) oder das Leeren abbrechen, OAuth-Anbieter abmelden. Roh-YAML schreiben bleibt aus: das
Schema-Formular ist der geprüfte Weg. Zu alte Hermes-Versionen enden über `DashboardClient` in einer klaren 501.
"""
from __future__ import annotations

import re
from typing import Annotated, Any, Literal

import yaml

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from pydantic import BaseModel, Field

from ..auth import User, current_user, fresh_user
from ..dashboard_ops import clip, redact
from .agents import Tgt, upstream
from .dashboard import Dash, audit
from .hermes_config import scrub

router = APIRouter(prefix="/bff/h/{host}/{runtime}/{agent}", dependencies=[Depends(current_user)])

CHECKPOINTS_PRUNE, SECURITY_AUDIT = "checkpoints-prune", "security-audit"  # feste Aktionsnamen von Hermes
OAuthId = Annotated[str, Path(pattern=r"^[a-z0-9][a-z0-9-]{0,63}$")]
MAX_ROWS = 500
PATH_RE = re.compile(r"(?<![\w:/])(?:~|[A-Za-z]:\\|/)(?:[\w.@+-]+[/\\])+[\w.@+-]*")  # absolute Pfade (Unix, ~, Windows) in Logs und Werten
TOKEN_RE = re.compile(r"\b(?:sk-[\w-]{8,}|gh[pousr]_\w{8,}|github_pat_\w{8,}|xox[abprs]-[\w-]{8,}|[rps]k_(?:live|test)_\w{8,}|AKIA[A-Z0-9]{12,})")
SECRET_PARTS = {"token", "secret", "password", "passwd", "pwd", "credential", "credentials", "key", "pat", "auth", "authorization", "cookie", "apikey", "bearer"}
MCP_HIDDEN = {"env", "headers", "args", "url", "cwd"}  # Umgebung, Argumente und Adressen von MCP-Servern bleiben draußen
GONE = "[entfernt]"


def strip_paths(text: str) -> str:
    return PATH_RE.sub("[Pfad]", TOKEN_RE.sub(GONE, text))


def _secret_key(key: str) -> bool:
    parts = [p for p in re.split(r"[^a-z0-9]+", re.sub(r"([a-z])([A-Z])", r"\1_\2", key).lower()) if p]
    return any(p in SECRET_PARTS for p in parts) or (len(parts) > 1 and parts[-2] + parts[-1] in {"apikey"})


def scrub_tree(value: Any, key: str = "", mcp: bool = False) -> Any:
    """Konfiguration für die Ansicht bereinigen: Werte unter Geheimnis-Schlüsseln, MCP-Umgebung/Argumente/Adressen, Pfade und Schlüsselformen fallen weg."""
    if isinstance(value, dict):
        return {k: (GONE if (mcp and str(k) in MCP_HIDDEN) else scrub_tree(v, str(k), mcp or str(k) == "mcp_servers")) for k, v in value.items()}
    if isinstance(value, list):
        return [scrub_tree(v, key, mcp) for v in value]
    if isinstance(value, bool) or value is None:
        return value
    if _secret_key(key) and isinstance(value, (str, int, float)):
        return GONE
    return strip_paths(value) if isinstance(value, str) else value


class Confirm(BaseModel):
    model_config = {"extra": "forbid"}
    confirm: str = ""


class DrainIn(BaseModel):
    model_config = {"extra": "forbid"}
    action: Literal["drain", "cancel"]
    confirm: str = ""
    suppress_notification: bool = False


def _limit(request: Request, user: User, what: str) -> None:
    request.app.state.limiter.check(f"{user.id}:{what}")


def _need(typed: str, word: str) -> None:
    if typed != word:
        raise HTTPException(422, f"Zum Bestätigen „{word}“ eintippen.")


def _int(v: Any) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None


# ---- Checkpoints ----
@router.get("/hermes-ops/checkpoints")
async def checkpoints(target: Tgt, dash: Dash):
    b = await upstream(dash.request("GET", "/api/ops/checkpoints", params={"profile": target.agent.id}))
    rows = b.get("sessions") if isinstance(b, dict) else None
    if not isinstance(rows, list):
        raise HTTPException(502, "Das Dashboard liefert die Checkpoints in unbekannter Form")
    out = [{"session": str(r["session"])[:80], "files": _int(r.get("files")), "bytes": _int(r.get("bytes"))}
           for r in rows[:MAX_ROWS] if isinstance(r, dict) and isinstance(r.get("session"), str)]
    return {"sessions": out, "total_bytes": _int(b.get("total_bytes")), "truncated": len(rows) > MAX_ROWS}


@router.post("/hermes-ops/checkpoints/prune", status_code=202)
async def checkpoints_prune(request: Request, target: Tgt, dash: Dash, req: Confirm, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-ops")
    _need(req.confirm, target.agent.id)
    await upstream(dash.request("POST", "/api/ops/checkpoints/prune", params={"profile": target.agent.id}))
    audit(request, user, "hermes_ops.checkpoints_prune", target)
    return {"ok": True, "action": CHECKPOINTS_PRUNE}


# ---- Sicherheitsprüfung (liest nur, startet einen Hintergrundlauf) ----
@router.post("/hermes-ops/security-audit", status_code=202)
async def security_audit(request: Request, target: Tgt, dash: Dash, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-ops")
    await upstream(dash.request("POST", "/api/ops/security-audit", params={"profile": target.agent.id}))
    audit(request, user, "hermes_ops.security_audit", target)
    return {"ok": True, "action": SECURITY_AUDIT}


@router.get("/hermes-ops/actions/{name}")
async def action_state(target: Tgt, dash: Dash, name: Literal["checkpoints-prune", "security-audit"]):
    b = await upstream(dash.request("GET", f"/api/actions/{name}/status"))
    if not isinstance(b, dict):
        raise HTTPException(502, "Das Dashboard liefert den Aktionszustand in unbekannter Form")
    log = b.get("log") if isinstance(b.get("log"), str) else "\n".join(str(x) for x in b.get("lines") or [])
    return {"action": name, "running": bool(b.get("running")), "exit_code": b.get("exit_code") if isinstance(b.get("exit_code"), int) else None, "log": strip_paths(redact(log))[-4000:]}


# ---- Gateway leeren ----
@router.post("/gateway/drain")
async def gateway_drain(request: Request, target: Tgt, dash: Dash, req: DrainIn, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-ops")
    if req.action == "drain":
        _need(req.confirm, "leeren")
    b = await upstream(dash.request("POST", "/api/gateway/drain", body={"action": req.action, "suppress_notification": req.suppress_notification}))
    if not isinstance(b, dict) or b.get("ok") is not True:
        raise HTTPException(502, "Das Dashboard hat das Leeren nicht bestätigt")
    audit(request, user, f"hermes_ops.gateway_drain_{req.action}", target)
    return {"ok": True, "action": req.action, "was_draining": b.get("was_draining") if isinstance(b.get("was_draining"), bool) else None}


# ---- Update-Beleg ----
@router.get("/hermes-ops/update-receipt")
async def update_receipt(target: Tgt, dash: Dash):
    try:
        b = await upstream(dash.request("GET", "/api/hermes/update/receipt"))
    except HTTPException as e:
        if e.status_code == 404:
            return {"receipt": None}  # kein Update seit Einführung der Belege
        raise
    s = b.get("summary") if isinstance(b, dict) else None
    if not isinstance(s, dict):
        raise HTTPException(502, "Das Dashboard liefert den Update-Beleg in unbekannter Form")
    out: dict[str, Any] = {k: strip_paths(clip(v, 200)) if isinstance(v, str) else v for k, v in s.items() if isinstance(v, (str, bool, int, float)) and k not in ("path", "pre_sha", "post_sha")}
    for k in ("followups", "fleet_states"):  # offene Folgeschritte gehören zum Ergebnis: „success“ allein wäre irreführend
        if isinstance(s.get(k), list):
            out[k] = [strip_paths(clip(x if isinstance(x, str) else (x.get("message") or x.get("name") or "") if isinstance(x, dict) else "", 300)) for x in s[k][:20]]
    if isinstance(s.get("user_action"), dict):
        out["user_action"] = {k: strip_paths(clip(v, 300)) for k, v in s["user_action"].items() if isinstance(v, str)}
    return {"receipt": out}


# ---- Konfiguration: Standardwerte und Roh-YAML nur lesen ----
@router.get("/hermes-config/defaults")
async def config_defaults(target: Tgt, dash: Dash):
    b = await upstream(dash.request("GET", "/api/config/defaults"))
    if not isinstance(b, dict):
        raise HTTPException(502, "Das Dashboard liefert die Standardwerte in unbekannter Form")
    return {"defaults": scrub(b)}


@router.get("/hermes-config/raw")
async def config_raw(target: Tgt, dash: Dash):
    b = await upstream(dash.request("GET", "/api/config/raw", params={"profile": target.agent.id}))
    text = b.get("yaml") if isinstance(b, dict) else None
    if not isinstance(text, str):
        raise HTTPException(502, "Das Dashboard liefert die Konfiguration in unbekannter Form")
    try:
        tree = yaml.safe_load(text) if text.strip() else {}
    except yaml.YAMLError as e:
        raise HTTPException(502, "Die Konfiguration des Dashboards ist kein gültiges YAML") from e
    clean = yaml.safe_dump(scrub_tree(tree), sort_keys=False, allow_unicode=True, default_flow_style=False)  # Kommentare gehen dabei verloren
    return {"yaml": clean[:200_000], "truncated": len(clean) > 200_000, "redacted": True}


# ---- OAuth abmelden ----
@router.delete("/providers/oauth/{provider}")
async def oauth_logout(request: Request, target: Tgt, dash: Dash, provider: OAuthId, req: Confirm, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-ops")
    _need(req.confirm, provider)
    await upstream(dash.request("DELETE", f"/api/providers/oauth/{provider}", params={"profile": target.agent.id}))
    audit(request, user, "hermes_oauth.logout", target, provider=provider)
    return {"ok": True, "provider": provider}
