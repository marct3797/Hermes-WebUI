"""Eingebautes Hermes-Gedächtnis (MEMORY.md/USER.md) und externe Gedächtnis-Anbieter eines Profils.

Das Dashboard liefert vom eingebauten Gedächtnis nur die Dateigrößen, nie den Inhalt. Anbieter und ihre Felder kommen vom Dashboard; Geheimnisse
werden nur geschrieben. Der Anbieter-Setup von Hermes (`POST .../setup`) führt Installationsbefehle mit Shell aus (`curl ... | sh`) und fehlt hier
absichtlich: die fehlenden Programme werden nur genannt. Zurücksetzen löscht ohne Papierkorb und verlangt, den Zielnamen einzutippen.
"""
from __future__ import annotations

import hashlib
import json
import math
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from pydantic import BaseModel, Field

from ..auth import User, current_user, fresh_user
from ..dashboard_ops import clip
from ..operations import HostdClient
from .agents import HostId, Tgt, upstream
from .dashboard import Dash, audit
from .tools import _check_value, pick, scope

router = APIRouter(prefix="/bff/h/{host}/{runtime}/{agent}", dependencies=[Depends(current_user)])

MemFile = Literal["MEMORY.md", "USER.md"]
MAX_MEM_CHARS = 262144  # hostd nimmt höchstens 256 KiB
OLD_HOSTD = "Der Host-Dienst ist zu alt für Gedächtnisdateien. Aktualisiere hostd auf dem Rechner."


class MemFileIn(BaseModel):
    content: str = Field(max_length=MAX_MEM_CHARS)
    expected_sha256: str = Field(min_length=1, max_length=128)


def _daemon(request: Request, host: HostId) -> HostdClient:
    from .operations import daemon
    return daemon(request, host)


def _profile(target: Tgt) -> str:
    return target.agent.id  # hostd-Profil = Agent-ID, wie scope() in tools.py


def _mem_err(exc: HTTPException) -> HTTPException:
    """hostd-Fehler ohne Pfade auf Deutsch abbilden."""
    if exc.status_code == 404:
        return HTTPException(501, OLD_HOSTD)
    if exc.status_code == 409:
        return HTTPException(409, "Die Datei wurde inzwischen geändert. Lade neu und speichere erneut.")
    if exc.status_code == 413:
        return HTTPException(413, "Die Datei ist zu groß für den Host-Dienst")
    if exc.status_code == 422:
        return HTTPException(422, "Der Inhalt ist ungültig (nur UTF-8-Text ohne NUL-Zeichen)")
    if exc.status_code in (401, 403):
        return HTTPException(502, "Der Host-Dienst lehnt die Anfrage ab")
    return HTTPException(exc.status_code if 400 <= exc.status_code < 600 else 502,
                         exc.detail if isinstance(exc.detail, str) else "Der Host-Dienst meldet einen Fehler")


async def _mem_get(request: Request, target: Tgt, suffix: str):
    try:
        return await _daemon(request, target.host.id).request("GET", f"/v1/profiles/{_profile(target)}/memory-files" + suffix)
    except HTTPException as exc:
        raise _mem_err(exc) from exc

Provider = Annotated[str, Path(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")]
FIELD_FIELDS = ("key", "label", "kind", "description", "info", "inline", "group", "placeholder", "required", "is_set", "options")
OPTION_FIELDS = ("value", "label", "description")
# Arten wie Hermes sie nennt (config_schema.py): text/select/secret/bool/number/json.
FIELD_KINDS = ("text", "select", "secret", "bool", "number", "json")
# Altformen älterer Dashboards (web_server_memory.py), nur lesbar: boolean/integer/checkbox.
KIND_ALIASES = {"boolean": "bool", "integer": "number", "checkbox": "bool"}


class ProviderIn(BaseModel):
    provider: str = Field(max_length=64, pattern=r"^([A-Za-z0-9][A-Za-z0-9_-]*)?$")


class ResetIn(BaseModel):
    target: Literal["all", "memory", "user"]
    confirm: str = ""


class ConfigIn(BaseModel):
    values: dict[str, Any] = Field(min_length=1, max_length=40)


def _limit(request: Request, user: User) -> None:
    request.app.state.limiter.check(f"{user.id}:hermes-memory")


async def _overview(target: Tgt, dash: Dash) -> dict[str, Any]:
    body = await upstream(dash.request("GET", "/api/memory", params=scope(target)))
    if not isinstance(body, dict) or not isinstance(body.get("providers"), list) or not isinstance(body.get("builtin_files"), dict):
        raise HTTPException(502, "Das Dashboard liefert das Gedächtnis in einer unbekannten Form")
    providers = []
    for p in body["providers"]:
        if not isinstance(p, dict) or not isinstance(p.get("name"), str):
            continue
        setup: dict[str, Any] = p["setup"] if isinstance(p.get("setup"), dict) else {}
        deps = [d for d in setup.get("external_dependencies", []) if isinstance(d, dict)] if not setup.get("dependencies_installed", True) else []
        providers.append({"name": p["name"], "label": clip(p.get("label"), 80) or None, "docs_url": str(p.get("docs_url") or "")[:500] or None,
                          "description": clip(p.get("description"), 200), "status": p.get("status"), "configured": bool(p.get("configured")), "available": bool(p.get("available")),
                          "required_env": [e for e in setup.get("required_env", []) if isinstance(e, str)],
                          "missing": [{"name": clip(d.get("name"), 60), "install": str(d.get("install") or "")[:200]} for d in deps]})
    files = {k: int(body["builtin_files"].get(k) or 0) for k in ("memory", "user")}
    return {"active": body.get("active") or "", "providers": providers, "files": files}


@router.get("/hermes-memory")
async def overview(target: Tgt, dash: Dash):
    return await _overview(target, dash)


@router.get("/hermes-memory/files")
async def mem_list(request: Request, target: Tgt):
    body = await _mem_get(request, target, "")
    files = body.get("files") if isinstance(body, dict) else None
    if not isinstance(files, list):
        raise HTTPException(502, "Der Host-Dienst liefert die Dateiliste in einer unbekannten Form")
    out = [f for f in files if isinstance(f, dict) and f.get("name") in ("MEMORY.md", "USER.md")]
    if len(out) != 2:
        raise HTTPException(502, "Der Host-Dienst liefert die Dateiliste in einer unbekannten Form")
    return {"files": out}


@router.get("/hermes-memory/files/{name}")
async def mem_read(request: Request, target: Tgt, name: MemFile):
    body = await _mem_get(request, target, f"/{name}")
    if not isinstance(body, dict) or body.get("name") != name or not isinstance(body.get("content"), str):
        raise HTTPException(502, "Der Host-Dienst liefert die Datei in einer unbekannten Form")
    return body


@router.put("/hermes-memory/files/{name}")
async def mem_write(request: Request, target: Tgt, name: MemFile, req: MemFileIn,
                    user: User = Depends(fresh_user)):
    _limit(request, user)
    if "\x00" in req.content:
        raise HTTPException(422, "Der Inhalt ist ungültig (nur UTF-8-Text ohne NUL-Zeichen)")
    try:
        result = await _daemon(request, target.host.id).request(
            "PUT", f"/v1/profiles/{_profile(target)}/memory-files/{name}",
            body={"content": req.content, "expected_sha256": req.expected_sha256})
    except HTTPException as exc:
        raise _mem_err(exc) from exc
    if not isinstance(result, dict):
        raise HTTPException(502, "Der Host-Dienst liefert die Datei in einer unbekannten Form")
    if result.get("sha256") != hashlib.sha256(req.content.encode()).hexdigest():  # Rücklesen: gespeichert ist nicht, was gesendet wurde
        raise HTTPException(502, "Der Host-Dienst hat die Datei nicht wie gesendet gespeichert")
    audit(request, user, "hermes_memory.file", target, file=name, chars=len(req.content))
    return result


@router.put("/hermes-memory/provider")
async def set_provider(request: Request, target: Tgt, dash: Dash, req: ProviderIn, user: User = Depends(fresh_user)):
    _limit(request, user)
    now = await _overview(target, dash)
    if req.provider:
        row = next((p for p in now["providers"] if p["name"] == req.provider), None)
        if row is None or row["status"] != "ready":
            raise HTTPException(422, "Dieser Anbieter ist unbekannt oder noch nicht bereit")
    await upstream(dash.request("PUT", "/api/memory/provider", body={"provider": req.provider}, params=scope(target)))
    if (await _overview(target, dash))["active"] != req.provider:
        raise HTTPException(502, "Das Dashboard hat die Änderung nicht übernommen")
    audit(request, user, "hermes_memory.provider", target, provider=req.provider or "built-in")
    return {"ok": True, "active": req.provider}


@router.post("/hermes-memory/reset")
async def reset(request: Request, target: Tgt, dash: Dash, req: ResetIn, user: User = Depends(fresh_user)):
    _limit(request, user)
    if req.confirm != req.target:
        raise HTTPException(422, f"Zum Bestätigen „{req.target}“ eintippen. Das Löschen ist endgültig.")
    body = await upstream(dash.request("POST", "/api/memory/reset", body={"target": req.target}, params=scope(target)))
    left = (await _overview(target, dash))["files"]
    if any(left[k] for k in ("memory", "user") if req.target in ("all", k)):
        raise HTTPException(502, "Das Dashboard hat die Änderung nicht übernommen")
    deleted = [x for x in (body.get("deleted") if isinstance(body, dict) else []) or [] if x in ("MEMORY.md", "USER.md")]
    audit(request, user, "hermes_memory.reset", target, scope=req.target, deleted=deleted)
    return {"ok": True, "deleted": deleted}


async def _fields(target: Tgt, dash: Dash, name: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    body = await upstream(dash.request("GET", f"/api/memory/providers/{name}/config", params=scope(target), missing="Unbekannter Gedächtnis-Anbieter"))
    if not isinstance(body, dict) or not isinstance(body.get("fields"), list):
        raise HTTPException(502, "Das Dashboard liefert die Felder in einer unbekannten Form")
    out = []
    for f in body["fields"]:
        if not isinstance(f, dict) or not isinstance(f.get("key"), str):
            continue
        kind_raw = str(f.get("kind") or "").strip().lower()
        kind = KIND_ALIASES.get(kind_raw, kind_raw)
        if kind not in FIELD_KINDS:
            raise HTTPException(502, "Das Dashboard liefert die Felder in einer unbekannten Form")
        row = pick(f, FIELD_FIELDS)
        row["kind"] = kind
        row["is_set"] = bool(row.get("is_set"))
        row["inline"] = bool(row.get("inline"))
        for k in ("info", "group", "placeholder", "label", "description"):
            if row.get(k) is not None:
                row[k] = clip(row[k], 500)
        row["options"] = [pick(o, OPTION_FIELDS) for o in f.get("options", []) if isinstance(o, dict)]
        for o in row["options"]:
            for k in ("value", "label", "description"):
                if o.get(k) is not None:
                    o[k] = clip(o[k], 200)
        if kind != "secret":
            v = f.get("value")
            row["value"] = clip(v, 2000) if isinstance(v, str) else (v if isinstance(v, bool | int | float) and not isinstance(v, bool) or isinstance(v, bool) else "")
        out.append(row)
    meta = {"label": clip(body.get("label"), 80) or None, "docs_url": str(body.get("docs_url") or "")[:500] or None}
    return out, meta


@router.get("/hermes-memory/providers/{name}")
async def provider_config(name: Provider, target: Tgt, dash: Dash):
    fields, meta = await _fields(target, dash, name)
    return {"name": name, "label": meta["label"], "docs_url": meta["docs_url"], "fields": fields}


def _value(field: dict[str, Any], value: Any) -> Any:
    key, kind = field["key"], field.get("kind")
    if kind in ("secret", "text"):
        if not isinstance(value, str):
            raise HTTPException(422, f"{key}: Text erwartet")
        return _check_value(key, value)
    if kind == "select":
        if not isinstance(value, str) or value not in {o["value"] for o in field["options"]}:
            raise HTTPException(422, f"{key}: kein erlaubter Wert")
        return value
    if kind == "bool":
        if isinstance(value, bool):
            return value
        if isinstance(value, str) and value.strip().lower() in ("1", "true", "yes", "on", "0", "false", "no", "off"):
            return value.strip().lower() in ("1", "true", "yes", "on")
        raise HTTPException(422, f"{key}: ungültiger Wert (wahr oder falsch erwartet)")
    if kind == "number":
        if isinstance(value, bool):
            raise HTTPException(422, f"{key}: ungültiger Wert (Zahl erwartet)")
        if isinstance(value, (int, float)):
            if not math.isfinite(value):
                raise HTTPException(422, f"{key}: ungültiger Wert (Zahl erwartet)")
            return value
        if isinstance(value, str) and value.strip():
            try:
                number = float(value.strip())
            except ValueError:
                raise HTTPException(422, f"{key}: ungültiger Wert (Zahl erwartet)")
            if not math.isfinite(number):
                raise HTTPException(422, f"{key}: ungültiger Wert (Zahl erwartet)")
            return int(number) if number.is_integer() else number
        raise HTTPException(422, f"{key}: ungültiger Wert (Zahl erwartet)")
    if kind == "json":
        if not isinstance(value, str):
            raise HTTPException(422, f"{key}: ungültiger Wert (JSON-Text erwartet)")
        text = value.strip()
        if not text:
            return ""
        try:
            parsed = json.loads(text)
        except ValueError:
            raise HTTPException(422, f"{key}: ungültiger Wert (kein gültiges JSON)")
        if not isinstance(parsed, (dict, list)):
            raise HTTPException(422, f"{key}: ungültiger Wert (nur Objekt oder Liste)")
        return _check_value(key, text)
    raise HTTPException(422, f"{key}: ungültiger Wert")


@router.put("/hermes-memory/providers/{name}")
async def save_provider(request: Request, name: Provider, target: Tgt, dash: Dash, req: ConfigIn, user: User = Depends(fresh_user)):
    _limit(request, user)
    before, _meta = await _fields(target, dash, name)
    fields = {f["key"]: f for f in before}
    values: dict[str, Any] = {}
    for key, raw in req.values.items():
        if key not in fields:
            raise HTTPException(422, f"{key}: kein Feld dieses Anbieters")
        v = _value(fields[key], raw)
        if not (fields[key].get("kind") == "secret" and v == ""):  # leerer Schlüssel löscht nichts
            values[key] = v
    result = await upstream(dash.request("PUT", f"/api/memory/providers/{name}/config", body={"values": values}, params=scope(target)))
    after, _meta2 = await _fields(target, dash, name)
    after_by_key = {f["key"]: f for f in after}
    wrong = sorted(k for k in values if fields[k].get("kind") == "secret" and not after_by_key.get(k, {}).get("is_set"))
    if wrong:
        raise HTTPException(502, "Das Dashboard hat nicht übernommen: " + ", ".join(wrong))
    audit(request, user, "hermes_memory.config", target, provider=name, keys=sorted(values))
    return {"ok": True, "active": result.get("active") if isinstance(result, dict) else None}
