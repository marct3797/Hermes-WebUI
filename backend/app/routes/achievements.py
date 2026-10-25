"""Achievements (P3): das Plugin gehört dem Dashboard des Hosts, nicht einem Profil. Schranken siehe tests/test_hermes_insights.py.

Geheime Erfolge zeigen weder Namen noch Kriterium; Sitzungen und Belege (Titel enthalten Nutzerinhalte) gehen nie an den Browser.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from ..auth import User, current_user, fresh_user
from ._dash import dash
from .kanban import HostId, Strict, _rec

router = APIRouter(prefix="/bff")
P = "/api/plugins/hermes-achievements"
MISSING = "Das Achievements-Plugin ist auf diesem Dashboard nicht verfügbar"


def _limit(request: Request, user: User) -> None:
    request.app.state.limiter.check(f"{user.id}:hermes-achievements")


def _summary(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict) or not isinstance(raw.get("achievements"), list):
        raise HTTPException(502, "Das Dashboard liefert die Achievements in unbekannter Form")
    items = []
    for a in raw["achievements"][:300]:
        if not isinstance(a, dict):
            continue
        secret = a.get("state") == "secret"
        items.append({"id": str(a.get("id"))[:80], "name": "???" if secret else str(a.get("name", ""))[:100],
                      "description": "Geheim, bis Hermes das erste passende Verhalten sieht." if secret else str(a.get("description", ""))[:300],
                      "category": str(a.get("category", ""))[:60], "icon": str(a.get("icon", ""))[:30], "state": str(a.get("state", ""))[:20], "unlocked": bool(a.get("unlocked")),
                      "tier": a.get("tier") if isinstance(a.get("tier"), str) else None, "progress": a.get("progress") if isinstance(a.get("progress"), int) else 0,
                      "next_threshold": a.get("next_threshold") if isinstance(a.get("next_threshold"), int) else None,
                      "progress_pct": a.get("progress_pct") if isinstance(a.get("progress_pct"), int) else 0,
                      "unlocked_at": a.get("unlocked_at") if isinstance(a.get("unlocked_at"), int) else None})
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
