"""Bot-Modus über den Host-Dienst: Peers (andere Hermes-Gateways) eintragen und ihnen Nachrichten schicken (`hermes peer ...`).

Hermes bietet das nur als CLI. hostd führt feste Aufrufe aus (siehe `hostd/peers.py`); hier gilt:
- Der Schlüssel eines Peers geht nur vom Browser über das BFF zu hostd (stdin). Zurück kommen nur Name, Adresse, Notiz und „Schlüssel gesetzt“.
- Senden geht nur an eingetragene Peers mit Schlüssel, asynchron (Lauf-Kennung), mit frischer Anmeldung, Rate-Limit und Audit ohne Nachrichtentext.
- Eintragen und Entfernen mit Rücklesen (502, wenn Hermes es nicht übernommen hat). Je Profil in hostd freizuschalten (`allow_peers`).
- Die Räume der WebUI sind ein eigenes Konzept (`rooms.db`) und hängen nicht hieran. Das Session-WebSocket (A2A) des Gateways ist Hermes-intern (Weiterleitung an das besitzende Profil) und hat keine Bedienfläche.
"""
from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from ..auth import User, current_user, fresh_user
from .agents import Tgt
from .dashboard import audit

router = APIRouter(prefix="/bff/h/{host}/{runtime}/{agent}", dependencies=[Depends(current_user)])

ERRORS = {
    404: "Profil ist in hostd nicht eingetragen, oder der Host-Dienst ist zu alt dafür.",
    403: "Für dieses Profil nicht freigeschaltet. Setze allow_peers in der hostd-Konfiguration.",
    409: "Hermes hat die Anfrage abgelehnt.",
    422: "Hermes oder der Host-Dienst hat die Eingabe abgelehnt (zum Beispiel Name, Adresse oder Lauf-Kennung).",
    426: "Hermes ist dafür zu alt. Aktualisiere Hermes auf diesem Rechner.",
    501: "Der Hermes-Client ist in hostd nicht eingerichtet (native_python und native_source).",
    502: "Der Hermes-Client in hostd hat nicht geantwortet.",
    503: "Der Hermes-Client ist nicht erreichbar.",
    504: "Keine Antwort in der Zeit. Das Ergebnis ist unbekannt: lade neu und prüfe, bevor du erneut sendest.",
}
WAIT = 140.0  # größer als die Grenze in hostd (120 s)
NAME = r"^[a-z0-9][a-z0-9_-]{0,63}$"
TARGET = r"^[a-z0-9][a-z0-9_-]{0,63}(/[A-Za-z0-9][A-Za-z0-9_-]{0,63})?$"
RUN_ID = r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$"
PEER_KEYS = ("name", "url", "note", "has_key")
RESULT_KEYS = ("peer", "profile", "session_id", "run_id", "status", "replayed", "idempotency_key", "output", "error")


async def _call(request: Request, target, body: dict[str, Any]) -> dict[str, Any]:
    from .operations import daemon
    try:
        out = await daemon(request, target.host.id).request("POST", f"/v1/profiles/{target.agent.id}/peers", body=body, messages=ERRORS, timeout=WAIT)
    except HTTPException as exc:
        if exc.status_code in (401, 405):
            raise HTTPException(502, "Der Host-Dienst lehnt die Anfrage ab") from exc
        raise
    if not isinstance(out, dict):
        raise HTTPException(502, "Der Host-Dienst liefert die Antwort in einer unbekannten Form")
    return out


async def _peers(request: Request, target) -> list[dict[str, Any]]:
    rows = (await _call(request, target, {"action": "list"})).get("peers")
    if not isinstance(rows, list):
        raise HTTPException(502, "Der Host-Dienst liefert die Peers in einer unbekannten Form")
    return [{k: r.get(k) for k in PEER_KEYS if k in r} for r in rows if isinstance(r, dict) and isinstance(r.get("name"), str)]


def _result(body: dict[str, Any]) -> dict[str, Any]:
    res = body.get("result") if isinstance(body.get("result"), dict) else {}
    out = {k: res[k] for k in RESULT_KEYS if isinstance(res.get(k), (str, bool, int, type(None))) and k in res}
    for k in ("output", "error"):
        if isinstance(out.get(k), str):
            out[k] = out[k][:20000]
    return out


@router.get("/peers")
async def peers(request: Request, target: Tgt) -> dict[str, Any]:
    return {"peers": await _peers(request, target)}


class PeerIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(pattern=NAME)
    url: str = Field(min_length=8, max_length=200)
    key: str = Field(default="", max_length=500)  # write-only
    note: str = Field(default="", max_length=200)


@router.post("/peers")
async def peer_add(request: Request, target: Tgt, req: PeerIn, user: User = Depends(fresh_user)) -> dict[str, Any]:
    request.app.state.limiter.check(f"{user.id}:peers")
    key = req.key.strip()
    before = {p["name"]: p for p in await _peers(request, target)}
    if not key and not (before.get(req.name) or {}).get("has_key"):
        raise HTTPException(422, "Für einen neuen Peer braucht es den API-Schlüssel seines Gateways (API_SERVER_KEY).")
    verified = False
    try:
        done = await _call(request, target, {"action": "add", "name": req.name, "url": req.url.strip(), "key": key, "note": req.note.strip()})
        row = next((p for p in await _peers(request, target) if p["name"] == req.name), None)
        verified = done.get("ok") is True and row is not None and row.get("url") == req.url.strip().rstrip("/") and row.get("has_key") is True
    except HTTPException as exc:
        audit(request, user, "peers.add", target, peer=req.name, verified=False, status=exc.status_code)
        raise
    audit(request, user, "peers.add", target, peer=req.name, verified=verified, key_changed=bool(key))
    if not verified:
        raise HTTPException(502, "Hermes hat den Peer nicht übernommen")
    return {"ok": True, "peer": row}


@router.delete("/peers/{name}")
async def peer_remove(request: Request, target: Tgt, name: str, confirm: str = "", user: User = Depends(fresh_user)) -> dict[str, Any]:
    request.app.state.limiter.check(f"{user.id}:peers")
    if not re.fullmatch(NAME, name):
        raise HTTPException(422, "Ungültiger Name.")
    if not any(p["name"] == name for p in await _peers(request, target)):
        raise HTTPException(404, "Peer nicht gefunden.")
    if confirm.strip() != name:
        raise HTTPException(422, f"Zum Bestätigen „{name}“ eintippen. Der Schlüssel bleibt in der .env von Hermes stehen.")
    ok = False
    try:
        done = await _call(request, target, {"action": "remove", "name": name})
        ok = done.get("ok") is True and all(p["name"] != name for p in await _peers(request, target))
    except HTTPException as exc:
        audit(request, user, "peers.remove", target, peer=name, verified=False, status=exc.status_code)
        raise
    audit(request, user, "peers.remove", target, peer=name, verified=ok)
    if not ok:
        raise HTTPException(502, "Hermes hat den Peer nicht entfernt")
    return {"ok": True}


class SendIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target: str = Field(pattern=TARGET)  # <peer> oder <peer>/<profil>
    message: str = Field(min_length=1, max_length=20000)
    idempotency_key: str = Field(default="", max_length=128, pattern=r"^([A-Za-z0-9][A-Za-z0-9_.:-]*)?$")


@router.post("/peers/send")
async def peer_send(request: Request, target: Tgt, req: SendIn, user: User = Depends(fresh_user)) -> dict[str, Any]:
    """Startet einen Lauf beim Peer (`hermes peer run`). Die Antwort kommt später über Status; ein Wiederholen mit derselben Schlüsselkennung führt den Lauf nicht doppelt aus."""
    request.app.state.limiter.check(f"{user.id}:peers")
    if not req.message.strip():
        raise HTTPException(422, "Die Nachricht ist leer.")
    peer = req.target.split("/", 1)[0]
    row = next((p for p in await _peers(request, target) if p["name"] == peer), None)
    if row is None or row.get("has_key") is not True:
        raise HTTPException(422, "Nur an eingetragene Peers mit Schlüssel.")
    body: dict[str, Any] = {"action": "run", "target": req.target, "message": req.message}
    if req.idempotency_key:
        body["idempotency_key"] = req.idempotency_key
    try:
        done = await _call(request, target, body)
    except HTTPException as exc:
        audit(request, user, "peers.send", target, peer=req.target, chars=len(req.message), verified=False, status=exc.status_code)
        raise
    result = _result(done)
    ok = done.get("ok") is True and isinstance(result.get("run_id"), str) and bool(result["run_id"])
    audit(request, user, "peers.send", target, peer=req.target, chars=len(req.message), run=result.get("run_id"), verified=ok)
    if not ok:
        raise HTTPException(502, f"Der Peer hat die Nachricht nicht angenommen: {str(done.get('error') or '')[:300]}")
    return {"ok": True, **result}


class RunIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target: str = Field(pattern=TARGET)
    run_id: str = Field(pattern=RUN_ID)


@router.post("/peers/status")
async def peer_status(request: Request, target: Tgt, req: RunIn, user: User = Depends(current_user)) -> dict[str, Any]:
    request.app.state.limiter.check(f"{user.id}:peers")
    done = await _call(request, target, {"action": "status", "target": req.target, "run_id": req.run_id})
    return {"ok": done.get("ok") is True, **_result(done), **({"error": str(done.get("error") or "")[:1000]} if done.get("ok") is not True else {})}


@router.post("/peers/stop")
async def peer_stop(request: Request, target: Tgt, req: RunIn, user: User = Depends(fresh_user)) -> dict[str, Any]:
    request.app.state.limiter.check(f"{user.id}:peers")
    try:
        done = await _call(request, target, {"action": "stop", "target": req.target, "run_id": req.run_id})
    except HTTPException as exc:
        audit(request, user, "peers.stop", target, peer=req.target, run=req.run_id, verified=False, status=exc.status_code)
        raise
    audit(request, user, "peers.stop", target, peer=req.target, run=req.run_id, verified=done.get("ok") is True)
    if done.get("ok") is not True:
        raise HTTPException(502, f"Der Peer hat den Stopp nicht bestätigt: {str(done.get('error') or '')[:300]}")
    return {"ok": True, **_result(done)}
