"""Hermes-Einstellungen eines Profils: das Schema und die Werte kommen vom Dashboard, die WebUI baut nichts nach.

GET liefert pro Feld Typ, Beschreibung, Kategorie und Wert. PUT nimmt nur geänderte Schlüssel (Punkt-Pfad) an, prüft sie gegen das
Schema, schickt sie verschachtelt an das Dashboard und liest danach zurück. Geheimnisse (Schlüssel, Tokens, Passwörter) verlassen das
BFF nie und lassen sich hier nicht schreiben: dafür gibt es „Keys & Nutzung“. Das Audit-Log nennt die Schlüssel, nie die Werte.
"""
from __future__ import annotations

import json
import math
import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

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
            item["value"] = value
        out.append(item)
    return {"fields": out, "category_order": order}


@router.put("/config")
async def write_config(request: Request, target: Tgt, dash: Dash, req: ConfigIn, user: User = Depends(fresh_user)):
    request.app.state.limiter.check(f"{user.id}:dashboard")
    fields, _, _ = await _schema_and_config(target, dash)
    for key, value in req.changes.items():
        if key not in fields:
            raise HTTPException(422, f"{key}: kein Feld dieses Profils")
        if is_secret(key, fields[key].get("type")):
            raise HTTPException(422, f"{key}: Geheimnisse werden unter „Keys & Nutzung“ verwaltet")
        check_value(key, fields[key], value)
    await upstream(dash.request("PUT", "/api/config", body={"config": nest(req.changes), "profile": target.agent.id}, params={"profile": target.agent.id}))
    _, _, after = await _schema_and_config(target, dash)
    dropped = sorted(k for k, v in req.changes.items() if lookup(after, k) != v)
    if dropped:
        raise HTTPException(502, "Das Dashboard hat nicht übernommen: " + ", ".join(dropped))
    audit(request, user, "profile.config", target, keys=sorted(req.changes))
    return {"ok": True, "changed": sorted(req.changes)}
