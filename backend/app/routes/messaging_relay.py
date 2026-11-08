"""Team-Gateway (Relay): Chat-Konten mit dem gemeinsamen Bot verknüpfen (Etappe 3 der Abdeckung).

Auf einer Instanz hinter dem Relay ist der gemeinsame Bot der einzige Weg zu Telegram, Discord, Slack. Die Verknüpfung läuft über einen
Einmalcode (`/link <code>`), den das laufende Gateway ausstellt. Der Code gehört zur Anzeige (der Nutzer schickt ihn dem Bot),
steht aber in keinem Audit-Eintrag. Das Relay gilt für das Dashboard als Ganzes, nicht für ein Profil.
Konten werden nur mit Kennung, Anzeigename und Zeitpunkt gezeigt; eine Trennung braucht frische Anmeldung und das Wort „trennen“.
"""
from __future__ import annotations

import re
from typing import Annotated, Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request

from ..auth import User, current_user, fresh_user
from .agents import Tgt, upstream
from .dashboard import Dash, audit

router = APIRouter(prefix="/bff/h/{host}/{runtime}/{agent}", dependencies=[Depends(current_user)])

Platform = Annotated[str, Path(pattern=r"^[a-z][a-z0-9_]{0,39}$")]
Code = Annotated[str, Path(pattern=r"^[A-Za-z0-9_-]{1,64}$")]
UserId = Annotated[str, Path(pattern=r"^[A-Za-z0-9_@+:=~-][A-Za-z0-9_@.+:=~-]{0,199}$")]
BASE = "/api/messaging/relay"


def clip(value: Any, limit: int) -> str:
    """Nur kürzen. Codes und Kennungen dürfen nicht durch die Schwärzung laufen: ein Code mit „token“ im Text würde unbrauchbar."""
    return re.sub(r"[\x00-\x1f]", " ", str(value))[:limit] if value is not None else ""


def _limit(request: Request, user: User) -> None:
    request.app.state.limiter.check(f"{user.id}:messaging-relay")


def _url(v: Any) -> str | None:
    return v if isinstance(v, str) and v.startswith("https://") and len(v) < 500 else None


def _first(d: dict[str, Any], *keys: str) -> str:
    for k in keys:
        if isinstance(d.get(k), (str, int)) and str(d[k]):
            return clip(str(d[k]), 200)
    return ""


def _account(a: Any) -> dict[str, str] | None:
    if not isinstance(a, dict):
        return None
    uid = _first(a, "platformUserId", "platform_user_id", "id")
    return {"id": uid, "label": _first(a, "displayName", "display_name", "username", "name"), "linked_at": _first(a, "linkedAt", "linked_at", "createdAt")} if uid else None


@router.get("/messaging-relay")
async def relay_status(target: Tgt, dash: Dash):
    b = await upstream(dash.request("GET", BASE))
    rows = b.get("platforms") if isinstance(b, dict) else None
    if not isinstance(rows, list):
        raise HTTPException(502, "Das Dashboard liefert das Relay in unbekannter Form")
    return {"managed_by": _first(b, "managed_by") or "connector", "portal_url": _url(b.get("portal_url")),
            "platforms": [{"platform": _first(r, "platform"), "bot_url": _url(r.get("bot_url")), "accounts": [x for x in map(_account, r.get("accounts") or []) if x]} for r in rows if isinstance(r, dict) and r.get("platform")]}


@router.post("/messaging-relay/{platform}/link")
async def relay_link(request: Request, target: Tgt, dash: Dash, platform: Platform, user: User = Depends(fresh_user)):
    _limit(request, user)
    b = await upstream(dash.request("POST", f"{BASE}/{platform}/link"))
    code = b.get("code") if isinstance(b, dict) else None
    if not isinstance(code, str) or not code:
        raise HTTPException(502, "Das Dashboard hat keinen Code ausgestellt")
    audit(request, user, "messaging.relay_link", target, platform=platform)
    return {"platform": platform, "code": clip(code, 64), "command": f"/link {clip(code, 64)}", "expires_at": b.get("expires_at") if isinstance(b.get("expires_at"), (str, int, float)) else None, "bot_url": _url(b.get("bot_url"))}


@router.get("/messaging-relay/link/{code}")
async def relay_link_state(target: Tgt, dash: Dash, code: Code):
    b = await upstream(dash.request("GET", f"{BASE}/link/{code}", missing="Der Code ist abgelaufen. Bitte einen neuen anfordern."))
    return {"state": _first(b, "state") or "inactive", "reason": clip(_first(b, "reason"), 200) or None}


@router.delete("/messaging-relay/{platform}/accounts/{user_id}")
async def relay_unlink(request: Request, target: Tgt, dash: Dash, platform: Platform, user_id: UserId, confirm: str = Query(default="", max_length=20), user: User = Depends(fresh_user)):
    _limit(request, user)
    if confirm.strip() != "trennen":
        raise HTTPException(422, "Zum Bestätigen „trennen“ eintippen.")
    b = await upstream(dash.request("DELETE", f"{BASE}/{platform}/accounts/{quote(user_id, safe='')}"))
    if not isinstance(b, dict) or b.get("unlinked") is not True:
        raise HTTPException(502, "Das Dashboard hat die Trennung nicht bestätigt")
    now = await relay_status(target, dash)
    gone = not any(a["id"] == user_id for r in now["platforms"] if r["platform"] == platform for a in r["accounts"])
    audit(request, user, "messaging.relay_unlink", target, platform=platform, verified=gone)
    if not gone:
        raise HTTPException(502, "Das Konto ist nach der Trennung noch verknüpft")
    return {"ok": True}
