"""Achievements (P3): das Plugin gehört dem Dashboard des Hosts, nicht einem Profil. Schranken siehe tests/test_hermes_insights.py.

Geheime Erfolge zeigen weder Namen noch Kriterium; Sitzungen und Belege (Titel enthalten Nutzerinhalte) gehen nie an den Browser.
"""
from __future__ import annotations

from typing import Annotated, Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Path, Request

from ..auth import User, current_user, fresh_user
from ..dashboard_ops import clip
from ._dash import dash
from .ops_more import strip_paths
from .kanban import HostId, Strict, _rec

router = APIRouter(prefix="/bff")
P = "/api/plugins/hermes-achievements"
MISSING = "Das Achievements-Plugin ist auf diesem Dashboard nicht verfügbar"


def _limit(request: Request, user: User) -> None:
    request.app.state.limiter.check(f"{user.id}:hermes-achievements")


def _item(a: dict[str, Any]) -> dict[str, Any]:
    secret = a.get("state") == "secret"
    return {"id": str(a.get("id"))[:80], "name": "???" if secret else str(a.get("name", ""))[:100],
            "description": "Geheim, bis Hermes das erste passende Verhalten sieht." if secret else str(a.get("description", ""))[:300],
            "category": str(a.get("category", ""))[:60], "icon": str(a.get("icon", ""))[:30], "state": str(a.get("state", ""))[:20], "unlocked": bool(a.get("unlocked")),
            "tier": a.get("tier") if isinstance(a.get("tier"), str) else None, "progress": a.get("progress") if isinstance(a.get("progress"), int) else 0,
            "next_threshold": a.get("next_threshold") if isinstance(a.get("next_threshold"), int) else None,
            "progress_pct": a.get("progress_pct") if isinstance(a.get("progress_pct"), int) else 0,
            "unlocked_at": a.get("unlocked_at") if isinstance(a.get("unlocked_at"), int) else None}


def _summary(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict) or not isinstance(raw.get("achievements"), list):
        raise HTTPException(502, "Das Dashboard liefert die Achievements in unbekannter Form")
    items = [_item(a) for a in raw["achievements"][:300] if isinstance(a, dict)]
    n = lambda k: raw.get(k) if isinstance(raw.get(k), int) else 0  # noqa: E731
    return {"total": n("total_count"), "unlocked": n("unlocked_count"), "discovered": n("discovered_count"), "secret": n("secret_count"),
            "generated_at": raw.get("generated_at") if isinstance(raw.get("generated_at"), int) else None, "is_stale": bool(raw.get("is_stale")), "items": items}


@router.get("/h/{host}/_achievements")
async def read(request: Request, host: HostId, user: User = Depends(current_user)):
    return _summary(await dash(request, host, "GET", f"{P}/achievements", missing=MISSING))


@router.post("/h/{host}/_achievements/rescan")
async def rescan(request: Request, host: HostId, user: User = Depends(fresh_user)):
    _limit(request, user)  # liest den gesamten Sitzungsverlauf
    out = _summary(await dash(request, host, "POST", f"{P}/rescan", body={}, missing=MISSING))
    _rec(request, user, "achievements.rescan", host)
    return out


class Reset(Strict):
    confirm: str = ""


@router.post("/h/{host}/_achievements/reset")
async def reset(request: Request, host: HostId, body: Reset, user: User = Depends(fresh_user)):
    _limit(request, user)
    if body.confirm != "reset":
        raise HTTPException(422, "Zurücksetzen löscht alle Freischaltungen: „reset“ zur Bestätigung eingeben")
    await dash(request, host, "POST", f"{P}/reset-state", body={}, missing=MISSING)
    if _summary(await dash(request, host, "GET", f"{P}/achievements", missing=MISSING))["unlocked"] != 0:
        raise HTTPException(502, "Das Dashboard hat die Achievements nicht zurückgesetzt")
    _rec(request, user, "achievements.reset", host)
    return {"ok": True}


@router.get("/h/{host}/_achievements/scan-status")
async def scan_status(request: Request, host: HostId, user: User = Depends(current_user)):
    """Stand der Prüfung. Der erste Lauf über den ganzen Verlauf dauert; die Seite fragt hier nach, statt zu raten."""
    raw = await dash(request, host, "GET", f"{P}/scan-status", missing=MISSING)
    if not isinstance(raw, dict) or raw.get("state") not in ("idle", "running", "failed"):
        raise HTTPException(502, "Das Dashboard liefert den Prüfstand in unbekannter Form")
    num = lambda k: raw.get(k) if isinstance(raw.get(k), (int, float)) and not isinstance(raw.get(k), bool) else None  # noqa: E731
    err = raw.get("last_error")
    return {"state": raw["state"], "started_at": num("started_at"), "finished_at": num("finished_at"), "duration_ms": num("last_duration_ms"), "runs": num("run_count") or 0,
            "error": strip_paths(clip(err, 200)) if isinstance(err, str) and err else None}


@router.get("/h/{host}/_achievements/recent")
async def recent(request: Request, host: HostId, user: User = Depends(current_user)):
    raw = await dash(request, host, "GET", f"{P}/recent-unlocks", missing=MISSING)
    if not isinstance(raw, list):
        raise HTTPException(502, "Das Dashboard liefert die letzten Freischaltungen in unbekannter Form")
    return {"items": [_item(a) for a in raw[:20] if isinstance(a, dict) and a.get("unlocked") is True]}


@router.get("/h/{host}/_achievements/sessions/{session_id}/badges")
async def session_badges(request: Request, host: HostId, session_id: Annotated[str, Path(pattern=r"^[A-Za-z0-9_.:-]{1,128}$")], user: User = Depends(current_user)):
    """Was eine einzelne Sitzung freischalten würde. Nur Erfolge, nie Inhalte der Sitzung."""
    raw = await dash(request, host, "GET", f"{P}/sessions/{quote(session_id, safe='')}/badges", missing=MISSING)
    badges = raw.get("badges") if isinstance(raw, dict) else None
    if not isinstance(badges, list):
        raise HTTPException(502, "Das Dashboard liefert die Sitzungs-Erfolge in unbekannter Form")
    return {"items": [_item(a) for a in badges[:50] if isinstance(a, dict)]}
