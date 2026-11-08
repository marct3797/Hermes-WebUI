"""Hermes-Einstellungen eines Profils: das Schema und die Werte kommen vom Dashboard, die WebUI baut nichts nach.

GET liefert pro Feld Typ, Beschreibung, Kategorie und Wert. PUT nimmt nur geänderte Schlüssel (Punkt-Pfad) an, prüft sie gegen das
Schema, schickt sie verschachtelt an das Dashboard und liest danach zurück. Geheimnisse (Schlüssel, Tokens, Passwörter) verlassen das
BFF nie und lassen sich hier nicht schreiben: dafür gibt es „Keys & Nutzung“. Das Audit-Log nennt die Schlüssel, nie die Werte.
"""
from __future__ import annotations

import json
import math
import re
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from ..auth import User, current_user, fresh_user
from .agents import Tgt, upstream
from .dashboard import Dash, audit

router = APIRouter(prefix="/bff/h/{host}/{runtime}/{agent}", dependencies=[Depends(current_user)])

# Nur Textfelder, deren letztes Namensglied nach einem Geheimnis klingt (`auxiliary.vision.api_key`, `dashboard.basic_auth.password`).
# Zählwerte (`threshold_tokens`), Schalter (`redact_secrets`) und Namen von Umgebungsvariablen (`..._token_env`) sind keine Geheimnisse.
SECRET_RE = re.compile(r"(api_?key|token|secret|password|passwd|credential|private_?key|auth_?key)(_hash)?$", re.I)
MAX_CHANGES, MAX_TEXT, MAX_JSON = 200, 20_000, 100_000


def is_secret(key: str, kind: str | None) -> bool:
    return kind in ("string", "text") and bool(SECRET_RE.search(key.rsplit(".", 1)[-1]))


def lookup(config: Any, key: str) -> Any:
    for part in key.split("."):
        if not isinstance(config, dict) or part not in config:
            return None
        config = config[part]
    return config


def scrub(value: Any) -> Any:
    """Geheimnisse in verschachtelten Werten (`fallback_providers[].api_key`) verlassen das BFF nie: Schlüssel mit Geheimnis-Namen entfallen."""
    if isinstance(value, dict):
        return {k: scrub(v) for k, v in value.items() if not (isinstance(v, str) and SECRET_RE.search(k))}
    if isinstance(value, list):
        return [scrub(v) for v in value]
    return value


def has_secret(value: Any) -> bool:
    if isinstance(value, dict):
        return any((isinstance(v, str) and SECRET_RE.search(k)) or has_secret(v) for k, v in value.items())
    return isinstance(value, list) and any(has_secret(v) for v in value)


def restore(new: Any, old: Any) -> Any:
    """Listeneinträge, die wir ohne Geheimnisse ausgeliefert haben, bekommen sie beim Speichern aus dem gespeicherten Stand zurück
    (gleiche Stelle und gleicher Anbieter; sonst der einzige Eintrag dieses Anbieters; sonst gleicher Anbieter mit gleichem Modell). Ein neuer Eintrag bekommt nichts."""
    if not (isinstance(new, list) and isinstance(old, list)):
        return new
    out = []
    for i, entry in enumerate(new):
        if not (isinstance(entry, dict) and "provider" in entry):
            out.append(entry)
            continue
        same = lambda o: isinstance(o, dict) and o.get("provider") == entry.get("provider")
        same_provider = [o for o in old if same(o)]
        match = (old[i] if i < len(old) and same(old[i]) else same_provider[0] if len(same_provider) == 1
                 else next((o for o in same_provider if o.get("model") == entry.get("model")), None))
        secrets = {k: v for k, v in (match or {}).items() if isinstance(v, str) and SECRET_RE.search(k) and k not in entry}
        out.append({**entry, **secrets})
    return out


def nest(changes: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in changes.items():
        node = out
        *path, leaf = key.split(".")
        for part in path:
            node = node.setdefault(part, {})
        node[leaf] = value
    return out


def check_value(key: str, field: dict[str, Any], value: Any) -> None:
    kind = field.get("type")
    ok = {
        "string": lambda v: isinstance(v, str) and len(v) <= MAX_TEXT,
        "text": lambda v: isinstance(v, str) and len(v) <= MAX_TEXT,
        "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v),
        "boolean": lambda v: isinstance(v, bool),
        "select": lambda v: isinstance(v, str) and (not field.get("options") or v in field["options"]),
        "list": lambda v: isinstance(v, list) and len(json.dumps(v)) <= MAX_JSON,
    }.get(kind)
    if ok is None:
        raise HTTPException(422, f"{key}: Typ „{kind}“ lässt sich hier nicht bearbeiten")
    if not ok(value):
        raise HTTPException(422, f"{key}: ungültiger Wert für Typ „{kind}“")


class ConfigIn(BaseModel):
    changes: dict[str, Any] = Field(min_length=1, max_length=MAX_CHANGES)


async def _schema_and_config(target: Tgt, dash: Dash) -> tuple[dict[str, Any], list[str], dict[str, Any]]:
    schema = await upstream(dash.request("GET", "/api/config/schema", params={"profile": target.agent.id}))
    config = await upstream(dash.request("GET", "/api/config", params={"profile": target.agent.id}))
    if not isinstance(schema, dict) or not isinstance(schema.get("fields"), dict) or not isinstance(config, dict):
        raise HTTPException(502, "Das Dashboard liefert die Einstellungen in einer unbekannten Form")
    return schema["fields"], list(schema.get("category_order") or []), config


@router.get("/config")
async def read_config(target: Tgt, dash: Dash):
    fields, order, config = await _schema_and_config(target, dash)
    out = []
    for key, meta in fields.items():
        item = {"key": key, "type": meta.get("type"), "description": meta.get("description") or key, "category": meta.get("category") or "general"}
        if meta.get("options") is not None:
            item["options"] = meta["options"]
        value = lookup(config, key)
        if is_secret(key, meta.get("type")):
            item.update(secret=True, set=bool(value), value=None)
        else:
            item["value"] = scrub(value)
        out.append(item)
    return {"fields": out, "category_order": order}


@router.put("/config")
async def write_config(request: Request, target: Tgt, dash: Dash, req: ConfigIn, user: User = Depends(fresh_user)):
    request.app.state.limiter.check(f"{user.id}:dashboard")
    fields, _, before = await _schema_and_config(target, dash)
    changes = dict(req.changes)
    for key, value in req.changes.items():
        if key not in fields:
            raise HTTPException(422, f"{key}: kein Feld dieses Profils")
        if is_secret(key, fields[key].get("type")):
            raise HTTPException(422, f"{key}: Geheimnisse werden unter „Keys & Nutzung“ verwaltet")
        check_value(key, fields[key], value)
        if has_secret(value):
            raise HTTPException(422, f"{key}: Geheimnisse in Listeneinträgen werden hier nicht geschrieben")
        changes[key] = restore(value, lookup(before, key))
    await upstream(dash.request("PUT", "/api/config", body={"config": nest(changes), "profile": target.agent.id}, params={"profile": target.agent.id}))
    _, _, after = await _schema_and_config(target, dash)
    dropped = sorted(k for k, v in req.changes.items() if scrub(lookup(after, k)) != v)
    if dropped:
        raise HTTPException(502, "Das Dashboard hat nicht übernommen: " + ", ".join(dropped))
    audit(request, user, "profile.config", target, keys=sorted(req.changes))
    return {"ok": True, "changed": sorted(req.changes)}


class EnvDeleteIn(BaseModel):
    key: str = Field(min_length=1, max_length=64)
    confirm: str = Field(default="", max_length=64)


@router.delete("/env/{key}")
async def delete_env(request: Request, key: str, target: Tgt, dash: Dash, req: EnvDeleteIn, user: User = Depends(fresh_user)):
    """Schlüssel aus der .env entfernen (mitsamt Spiegeln in Anbietern). Bestätigung: Schlüssel eintippen. Nie Klartext zurück."""
    request.app.state.limiter.check(f"{user.id}:dashboard")
    if not re.match(r"^[A-Z][A-Z0-9_]{0,63}$", key) or req.key != key:
        raise HTTPException(422, "Schlüssel: nur Großbuchstaben, Ziffern, Unterstrich")
    if req.confirm != key:
        raise HTTPException(422, "Löschen: den Schlüsselnamen zur Bestätigung eintippen")
    body = await upstream(dash.request("DELETE", "/api/env", body={"key": key}, params={"profile": target.agent.id}, missing="Schlüssel nicht gefunden"))
    if not isinstance(body, dict):
        raise HTTPException(502, "Das Dashboard liefert die Antwort in einer unbekannten Form")
    audit(request, user, "profile.env_delete", target, keys=[key])
    return {"ok": True, "key": key}


# Provider-Routing (OpenRouter): `provider_routing` steht nicht im Schema des Dashboards (kein Eintrag in DEFAULT_CONFIG), die
# Einstellungen-Maske kann es also nicht schreiben. Dashboard-PUT /api/config mischt aber beliebige Schlüssel per Tiefenmischung
# ein: ein fehlender Schlüssel würde einen alten Wert NICHT löschen. Darum gehen immer alle sechs Schlüssel mit ihrem neutralen
# Wert (leere Listen, `null`, `false`); `sort: null` heißt „nicht gesetzt“ (OpenRouter gewichtet dann selbst) und ist der Standard von Hermes raus; `models` (Einträge je Modell) bleibt unberührt.
SLUG_RE = r"^[a-z0-9][a-z0-9._/-]{0,63}$"
ROUTING_DEFAULT: dict[str, Any] = {"sort": None, "only": [], "ignore": [], "order": [], "require_parameters": False, "data_collection": None}
Slugs = list[str]


class RoutingIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sort: Literal["price", "throughput", "latency"] | None = None
    only: Slugs = Field(default_factory=list, max_length=50)
    ignore: Slugs = Field(default_factory=list, max_length=50)
    order: Slugs = Field(default_factory=list, max_length=50)
    require_parameters: bool = False
    data_collection: Literal["allow", "deny"] | None = None


def _routing_view(config: dict[str, Any]) -> dict[str, Any]:
    raw = config.get("provider_routing")
    raw = raw if isinstance(raw, dict) else {}
    out = dict(ROUTING_DEFAULT)
    if raw.get("sort") in ("price", "throughput", "latency"):
        out["sort"] = raw["sort"]
    for key in ("only", "ignore", "order"):
        value = raw.get(key)
        out[key] = [x for x in value if isinstance(x, str)] if isinstance(value, list) else []
    out["require_parameters"] = raw.get("require_parameters") is True
    out["data_collection"] = raw["data_collection"] if raw.get("data_collection") in ("allow", "deny") else None
    models = raw.get("models")
    return {"routing": out, "per_model": sorted(str(k) for k in models) if isinstance(models, dict) else []}


@router.get("/provider-routing")
async def read_routing(target: Tgt, dash: Dash):
    config = await upstream(dash.request("GET", "/api/config", params={"profile": target.agent.id}))
    if not isinstance(config, dict):
        raise HTTPException(502, "Das Dashboard liefert die Einstellungen in einer unbekannten Form")
    return _routing_view(config)


@router.put("/provider-routing")
async def write_routing(request: Request, target: Tgt, dash: Dash, req: RoutingIn, user: User = Depends(fresh_user)):
    import re
    request.app.state.limiter.check(f"{user.id}:dashboard")
    for key in ("only", "ignore", "order"):
        values = getattr(req, key)
        if any(not re.match(SLUG_RE, v) for v in values) or len(set(values)) != len(values):
            raise HTTPException(422, f"{key}: nur kleingeschriebene Anbieter-Kennungen, ohne Doppelte")
    wanted = req.model_dump()
    await upstream(dash.request("PUT", "/api/config", body={"config": {"provider_routing": wanted}, "profile": target.agent.id}, params={"profile": target.agent.id}))
    after = await upstream(dash.request("GET", "/api/config", params={"profile": target.agent.id}))
    if not isinstance(after, dict) or _routing_view(after)["routing"] != wanted:
        raise HTTPException(502, "Das Dashboard hat das Routing nicht übernommen")
    audit(request, user, "profile.provider_routing", target, keys=sorted(wanted))
    return {"ok": True, **_routing_view(after)}
