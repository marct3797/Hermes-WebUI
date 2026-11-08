"""Zugangsdaten über den Host-Dienst: lokaler Tresor (`hermes vault`) und Secrets-Anbieter (`hermes secrets ...`).

Hermes bietet beides nur als CLI. hostd führt feste Aufrufe aus (siehe `hostd/credentials.py`); hier gilt:
- Passwörter und Karten gehen nur vom Browser über das BFF zu hostd (stdin des Hermes-Prozesses). Zurück kommen nur Metadaten, nie ein Wert.
- Schreiben: frische Anmeldung, Rate-Limit, Bestätigungswort bei Löschen und Abschalten, Rücklesen (502, wenn Hermes es nicht übernommen hat), Audit ohne Inhalt.
- Je Profil in hostd freizuschalten (`allow_vault`, `allow_secrets`). Ein zu altes hostd oder Hermes ergibt 501.
"""
from __future__ import annotations

import re
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from ..auth import User, current_user, fresh_user
from .agents import Tgt
from .dashboard import audit

router = APIRouter(prefix="/bff/h/{host}/{runtime}/{agent}", dependencies=[Depends(current_user)])

OLD_HOSTD = "Der Host-Dienst ist zu alt für Tresor und Secrets. Aktualisiere hostd auf dem Rechner."
ERRORS = {
    404: "Profil oder Quelle sind in hostd nicht eingetragen, oder der Host-Dienst ist zu alt dafür.",
    403: "Für dieses Profil nicht freigeschaltet. Setze allow_vault, allow_secrets bzw. allow_distributions in der hostd-Konfiguration (bei Distributionen auch: das Zielprofil ist nicht freigegeben, oder die im Profil gespeicherte Quelle weicht von der gewählten ab).",
    409: "Hermes hat die Änderung abgelehnt, oder die Quelle hat sich seit der Vorschau geändert (Vorschau neu laden), oder das Profil ist schon vorhanden (dann bewusst überschreiben), oder eine andere Änderung desselben Profils läuft noch, oder im Profil ist eine andere Voreinstellung (active_profile) gesetzt.",
    422: "Hermes oder der Host-Dienst hat die Eingabe abgelehnt (zum Beispiel ein Pflichtfeld oder ein ungültiges Zeichen).",
    426: "Hermes ist dafür zu alt. Aktualisiere Hermes auf diesem Rechner.",
    501: "Der Hermes-Client ist in hostd nicht eingerichtet (native_python und native_source).",
    502: "Der Hermes-Client in hostd hat nicht geantwortet.",
    503: "Der Hermes-Client ist nicht erreichbar.",
    504: "Keine Antwort in der Zeit. Das Ergebnis ist unbekannt: lade neu und prüfe.",
}
ITEM_KEYS = ("id", "kind", "label", "origin", "created_at", "identifier", "identifier_type", "has_otp")
ENV_NAME = r"^[A-Z][A-Z0-9_]{0,99}$"
DISABLE_WORD = "ausschalten"
WAIT = 70.0  # größer als die Grenzen in hostd (30 s); sonst meldet das BFF Zeitüberschreitung, während hostd noch arbeitet
REFERENCE = re.compile(r"^op://[^\x00-\x1f\x7f-\x9f\u2028\u2029\"'`$\\;|&<>\[\]]{1,120}$")
REQUIRED = {"payment": ("card_number", "exp_month", "exp_year", "cvc"), "address": ("address_line1", "city", "postal_code", "country")}


def _daemon(request: Request, host: str):
    from .operations import daemon
    return daemon(request, host)


async def _call(request: Request, target, method: str, path: str, body: Any = None, wait: float = WAIT) -> dict[str, Any]:
    try:
        out = await _daemon(request, target.host.id).request(method, f"/v1/profiles/{target.agent.id}/{path}", body=body, messages=ERRORS, timeout=wait)
    except HTTPException as exc:
        if exc.status_code in (401, 405):
            raise HTTPException(502, "Der Host-Dienst lehnt die Anfrage ab") from exc
        raise
    if not isinstance(out, dict):
        raise HTTPException(502, "Der Host-Dienst liefert die Antwort in einer unbekannten Form")
    return out


def _items(body: dict[str, Any]) -> list[dict[str, Any]]:
    rows = body.get("items")
    if not isinstance(rows, list):
        raise HTTPException(502, "Der Host-Dienst liefert den Tresor in einer unbekannten Form")
    return [{k: r.get(k) for k in ITEM_KEYS if k in r} for r in rows if isinstance(r, dict) and isinstance(r.get("id"), str)]


@router.get("/vault")
async def vault(request: Request, target: Tgt) -> dict[str, Any]:
    body = await _call(request, target, "GET", "vault")
    storage = body.get("key_storage")
    return {"items": _items(body), "key_storage": storage if storage in ("file", "keychain") else None}


class VaultIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["login", "payment", "address"]
    label: str = Field(min_length=1, max_length=200)
    origin: str = Field(default="", max_length=500)
    # login
    identifier_type: Literal["email", "phone", "username"] = "email"
    identifier: str = Field(default="", max_length=300)
    password: str = Field(default="", max_length=2000)  # write-only
    otp_secret: str = Field(default="", max_length=500)  # write-only
    # payment / address (write-only)
    fields: dict[str, str] = Field(default_factory=dict, max_length=12)


PAYMENT = {"card_number", "cardholder_name", "exp_month", "exp_year", "cvc", "billing_postal_code"}
ADDRESS = {"address_line1", "address_line2", "city", "state", "postal_code", "country"}


@router.post("/vault")
async def vault_add(request: Request, target: Tgt, req: VaultIn, user: User = Depends(fresh_user)) -> dict[str, Any]:
    request.app.state.limiter.check(f"{user.id}:vault")
    if req.kind == "login":
        if not (req.identifier.strip() and req.password and req.origin.strip()):
            raise HTTPException(422, "Für ein Login braucht es Adresse, Kennung und Passwort.")
        secret = {"identifier_type": req.identifier_type, "identifier": req.identifier.strip(), "password": req.password}
        if req.otp_secret.strip():
            secret["otp_secret"] = req.otp_secret.strip()
    else:
        allowed = PAYMENT if req.kind == "payment" else ADDRESS
        if any(k not in allowed or len(v) > 300 for k, v in req.fields.items()):
            raise HTTPException(422, "Unbekanntes oder zu langes Feld.")
        secret = {k: v.strip() for k, v in req.fields.items() if v.strip()}
        missing = [k for k in REQUIRED[req.kind] if k not in secret]
        if missing:
            raise HTTPException(422, "Es fehlen Angaben: " + ", ".join(missing))
    verified = False
    try:
        body = await _call(request, target, "POST", "vault", {"kind": req.kind, "label": req.label.strip(), "origin": req.origin.strip(), "secret": secret})
        item = body.get("item") if isinstance(body.get("item"), dict) else None
        after = _items(await _call(request, target, "GET", "vault"))
        verified = bool(item) and any(i["id"] == item.get("id") and i.get("label") == req.label.strip() for i in after)
    except HTTPException as exc:
        audit(request, user, "vault.add", target, kind=req.kind, verified=False, status=exc.status_code)  # auch ein unklarer Ausgang gehört ins Protokoll
        raise
    audit(request, user, "vault.add", target, kind=req.kind, verified=verified)
    if not verified:
        raise HTTPException(502, "Hermes hat den Eintrag nicht übernommen")
    return {"ok": True, "item": {k: item.get(k) for k in ITEM_KEYS if k in item}}


@router.delete("/vault/{item}")
async def vault_remove(request: Request, target: Tgt, item: str, confirm: str = "", user: User = Depends(fresh_user)) -> dict[str, Any]:
    request.app.state.limiter.check(f"{user.id}:vault")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", item):
        raise HTTPException(422, "Ungültige Kennung.")
    before = _items(await _call(request, target, "GET", "vault"))
    row = next((i for i in before if i["id"] == item), None)
    if row is None:
        raise HTTPException(404, "Eintrag nicht gefunden.")
    if confirm.strip() != (row.get("label") or ""):
        raise HTTPException(422, f"Zum Bestätigen „{row.get('label')}“ eintippen. Das Löschen ist endgültig.")
    ok = False
    try:
        await _call(request, target, "DELETE", f"vault/{item}")
        after = _items(await _call(request, target, "GET", "vault"))
        ok = all(i["id"] != item for i in after)
    except HTTPException as exc:
        audit(request, user, "vault.remove", target, kind=row.get("kind"), verified=False, status=exc.status_code)
        raise
    audit(request, user, "vault.remove", target, kind=row.get("kind"), verified=ok)
    if not ok:
        raise HTTPException(502, "Hermes hat den Eintrag nicht gelöscht")
    return {"ok": True}


Provider = Literal["bitwarden", "onepassword"]
YES = re.compile(r"Enabled\s+(yes|no)\b")


def _view(body: dict[str, Any]) -> dict[str, Any]:
    out = body.get("output")
    return {"ok": body.get("ok") is True, "output": out[:20000] if isinstance(out, str) else "", "truncated": bool(body.get("truncated"))}


def _enabled(output: str) -> bool | None:
    m = YES.search(output)
    return None if m is None else m.group(1) == "yes"


@router.post("/secrets/{provider}/status")
async def secrets_status(request: Request, target: Tgt, provider: Provider, user: User = Depends(current_user)) -> dict[str, Any]:
    request.app.state.limiter.check(f"{user.id}:secrets")
    view = _view(await _call(request, target, "POST", "secrets", {"provider": provider, "action": "status"}))
    return {**view, "enabled": _enabled(view["output"])}


@router.post("/secrets/{provider}/sync")
async def secrets_sync(request: Request, target: Tgt, provider: Provider, user: User = Depends(fresh_user)) -> dict[str, Any]:
    """Probelauf: zeigt nur Namen, was geholt würde (Hermes führt ohne `--apply` nichts aus). Hermes holt dafür alle Werte in seinen Prozess und lädt bei Bitwarden nötigenfalls `bws` herunter: deshalb frische Anmeldung."""
    request.app.state.limiter.check(f"{user.id}:secrets")
    view = _view(await _call(request, target, "POST", "secrets", {"provider": provider, "action": "sync"}))
    audit(request, user, "secrets.sync", target, provider=provider, ok=view["ok"])
    return view


class SecretsChange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["disable", "set", "remove"]
    env_var: str = Field(default="", max_length=100, pattern=r"^([A-Z][A-Z0-9_]*)?$")
    reference: str = Field(default="", max_length=120)
    confirm: str = Field(default="", max_length=100)


@router.post("/secrets/{provider}/change")
async def secrets_change(request: Request, target: Tgt, provider: Provider, req: SecretsChange, user: User = Depends(fresh_user)) -> dict[str, Any]:
    request.app.state.limiter.check(f"{user.id}:secrets")
    payload: dict[str, Any] = {"provider": provider, "action": req.action}
    if req.action == "disable":
        if req.confirm.strip() != DISABLE_WORD:
            raise HTTPException(422, f"Zum Bestätigen „{DISABLE_WORD}“ eintippen.")
    else:
        if provider != "onepassword":
            raise HTTPException(422, "Zuordnungen gibt es nur bei 1Password.")
        if not req.env_var:
            raise HTTPException(422, "Variablenname fehlt.")
        payload["env_var"] = req.env_var
        if req.action == "set":
            if not REFERENCE.fullmatch(req.reference.strip()):
                raise HTTPException(422, "Die Referenz beginnt mit op:// und ist höchstens 120 Zeichen lang, ohne Steuerzeichen und eckige Klammern.")
            payload["reference"] = req.reference.strip()
        elif req.confirm.strip() != req.env_var:
            raise HTTPException(422, f"Zum Bestätigen „{req.env_var}“ eintippen.")
    ok = False
    try:
        done = _view(await _call(request, target, "POST", "secrets", payload))
        after = _view(await _call(request, target, "POST", "secrets", {"provider": provider, "action": "status"}))
        readable = after["ok"] and not after["truncated"]  # nur eine lesbare Statusausgabe belegt etwas
        present = re.search(rf"(?<![A-Z0-9_]){re.escape(req.env_var)}(?![A-Z0-9_])", after["output"]) if req.env_var else None
        if req.action == "disable":
            ok = done["ok"] and readable and _enabled(after["output"]) is False
        elif req.action == "set":
            ok = done["ok"] and readable and bool(present) and req.reference.strip() in after["output"]
        else:
            if not done["ok"] and readable and not present:
                raise HTTPException(404, "Diese Zuordnung gibt es nicht.")
            ok = done["ok"] and readable and not present
    except HTTPException as exc:
        audit(request, user, f"secrets.{req.action}", target, provider=provider, verified=False, status=exc.status_code)
        raise
    audit(request, user, f"secrets.{req.action}", target, provider=provider, verified=ok)
    if not ok:
        raise HTTPException(502, "Hermes hat die Änderung nicht übernommen")
    return {"ok": True, "output": after["output"], "enabled": _enabled(after["output"])}
