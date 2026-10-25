"""Modelle (Punkt 8a): Hauptmodell, Auswahl, Empfehlung, Hilfsmodelle, MoA.

Lesen ist frei. Schreiben braucht eine frische Anmeldung plus Rate-Limit und wird auditiert. Das Dashboard schreibt sofort
in config.yaml und gilt nur für neue Sitzungen — deshalb:
- leere/Provider-freie Antworten sind 502 (kein stilles „kein Modell"),
- teure Modelle brauchen `confirm_expensive_model` (der erste Versuch antwortet mit `confirm_required`, ändert nichts),
- MoA braucht benannte Presets mit Referenzmodellen,
- die Empfehlung wird gegen die Auswahl geprüft (kein Hinzufügen erfundener Modelle),
- Geheimnisse (`api_key`) verlassen das BFF nie und stehen nie im Audit.
"""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ..auth import User, current_user, fresh_user
from .agents import Tgt, upstream
from .dashboard import Dash, audit

router = APIRouter(prefix="/bff/h/{host}/{runtime}/{agent}", dependencies=[Depends(current_user)])

EXPENSIVE = ("opus", "o1", "o3", "gpt-5", "claude-teuer")


def _limit(request: Request, user: User, what: str) -> None:
    request.app.state.limiter.check(f"{user.id}:{what}")


def _profile(name: str) -> dict[str, str]:
    return {"profile": name}


async def _read(dash: Dash, name: str, path: str) -> Any:
    return await upstream(dash.request("GET", path, params=_profile(name)))


def _known_models(opts: Any) -> set[str]:
    known: set[str] = set()
    provs = opts.get("providers") if isinstance(opts, dict) else None
    if isinstance(provs, list):
        for p in provs:
            if isinstance(p, dict) and isinstance(p.get("models"), list):
                known |= {m for m in p["models"] if isinstance(m, str)}
    cur = opts.get("current", {}) if isinstance(opts, dict) else {}
    if isinstance(cur, dict) and isinstance(cur.get("model"), str):
        known.add(cur["model"])
    return known


@router.get("/hermes-models/info")
async def model_info(target: Tgt, dash: Dash):
    body = await _read(dash, target.agent.id, "/api/model/info")
    if not isinstance(body, dict) or not body.get("provider") or not body.get("model"):
        raise HTTPException(502, "Das Dashboard liefert Modell-Info in unbekannter Form")
    ctx = body.get("context_window")
    if not isinstance(ctx, int):
        auto = body.get("auto_context_length")
        ctx = auto if isinstance(auto, int) else 0
    return {"provider": body["provider"], "model": body["model"], "context_window": ctx,
            "capabilities": body.get("capabilities") if isinstance(body.get("capabilities"), dict) else {}}


@router.get("/hermes-models/options")
async def model_options(target: Tgt, dash: Dash):
    body = await _read(dash, target.agent.id, "/api/model/options")
    provs = body.get("providers") if isinstance(body, dict) else None
    if not isinstance(provs, list) or not provs:
        raise HTTPException(502, "Das Dashboard liefert die Modellauswahl in unbekannter Form")
    return {"providers": provs, "current": body.get("current") if isinstance(body.get("current"), dict) else {}}


@router.get("/hermes-models/recommended-default")
async def model_recommended(target: Tgt, dash: Dash):
    rec = await _read(dash, target.agent.id, "/api/model/recommended-default")
    if not isinstance(rec, dict) or not rec.get("provider") or not rec.get("model"):
        raise HTTPException(502, "Das Dashboard liefert die Modellempfehlung in unbekannter Form")
    opts = await _read(dash, target.agent.id, "/api/model/options")
    if rec["model"] not in _known_models(opts):
        raise HTTPException(502, "Die Empfehlung nennt ein Modell, das nicht in der Auswahl steht")
    return {"provider": rec["provider"], "model": rec["model"]}


@router.get("/hermes-models/auxiliary")
async def model_auxiliary(target: Tgt, dash: Dash):
    body = await _read(dash, target.agent.id, "/api/model/auxiliary")
    tasks = body.get("tasks") if isinstance(body, dict) else None
    main = body.get("main") if isinstance(body, dict) else None
    if not isinstance(tasks, list) or not tasks or not isinstance(main, dict) or not main.get("model"):
        raise HTTPException(502, "Das Dashboard liefert die Hilfsmodelle in unbekannter Form")
    return {"main": main, "tasks": tasks}


@router.get("/hermes-models/moa")
async def moa_read(target: Tgt, dash: Dash):
    body = await _read(dash, target.agent.id, "/api/model/moa")
    presets = body.get("presets") if isinstance(body, dict) else None
    if not isinstance(presets, dict) or not presets:
        raise HTTPException(502, "Das Dashboard liefert die MoA-Presets in unbekannter Form")
    active = body.get("active_preset", "")
    if active and active not in presets:
        raise HTTPException(502, "Das aktive MoA-Preset gibt es nicht in der Preset-Liste")
    return {"presets": presets, "active_preset": active, "default_preset": body.get("default_preset", "")}


class SetIn(BaseModel):
    model_config = {"extra": "forbid"}
    scope: Literal["main", "auxiliary"]
    provider: str = Field(min_length=1, max_length=100)
    model: str = Field(min_length=1, max_length=200)
    task: str = Field(default="", max_length=100)
    reasoning_effort: str | None = Field(default=None, max_length=20)
    base_url: str = Field(default="", max_length=500)
    api_key: str = Field(default="", max_length=5000)
    confirm_expensive_model: bool = False


@router.post("/hermes-models/set")
async def model_set(request: Request, target: Tgt, dash: Dash, req: SetIn, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-models")
    model = req.model.strip()
    if not model:
        raise HTTPException(422, "Modell: leerer Name ist kein Modell")
    lowered = model.lower()
    if any(tag in lowered for tag in EXPENSIVE) and not req.confirm_expensive_model:
        return {"ok": False, "confirm_required": True,
                "confirm_message": f"„{model}“ ist ein teures Modell. Erneut senden mit confirm_expensive_model=true, um zu bestätigen."}
    payload: dict[str, Any] = {"scope": req.scope, "provider": req.provider.strip(), "model": model,
                               "task": req.task, "confirm_expensive_model": req.confirm_expensive_model}
    if req.reasoning_effort is not None:
        payload["reasoning_effort"] = req.reasoning_effort
    if req.base_url:
        payload["base_url"] = req.base_url
    if req.api_key:
        payload["api_key"] = req.api_key
    await upstream(dash.request("POST", "/api/model/set", body=payload, params=_profile(target.agent.id)))
    back = await _read(dash, target.agent.id, "/api/model/info")
    if not isinstance(back, dict) or back.get("model") != model:
        raise HTTPException(502, "Das Dashboard hat das Modell nicht übernommen")
    audit(request, user, "models.set", target, scope=req.scope, provider=req.provider, model=model)
    return {"ok": True, "provider": req.provider, "model": model}


class MoaSlot(BaseModel):
    model_config = {"extra": "forbid"}
    provider: str = Field(min_length=1, max_length=100)
    model: str = Field(min_length=1, max_length=200)


class MoaPreset(BaseModel):
    model_config = {"extra": "forbid"}
    reference_models: list[MoaSlot] = Field(min_length=1)
    aggregator: MoaSlot


class MoaIn(BaseModel):
    model_config = {"extra": "forbid"}
    default_preset: str = Field(min_length=1, max_length=100)
    active_preset: str = Field(min_length=1, max_length=100)
    presets: dict[str, MoaPreset] = Field(min_length=1)


@router.put("/hermes-models/moa")
async def moa_write(request: Request, target: Tgt, dash: Dash, req: MoaIn, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-models")
    if req.active_preset not in req.presets or req.default_preset not in req.presets:
        raise HTTPException(422, "Aktives/Standard-Preset: dieses Preset ist nicht in presets enthalten")
    await upstream(dash.request("PUT", "/api/model/moa", body=req.model_dump(), params=_profile(target.agent.id)))
    back = await _read(dash, target.agent.id, "/api/model/moa")
    presets = back.get("presets") if isinstance(back, dict) else None
    if not isinstance(presets, dict) or back.get("active_preset") != req.active_preset:
        raise HTTPException(502, "Das Dashboard hat die MoA-Presets nicht übernommen")
    audit(request, user, "models.moa", target, active=req.active_preset, presets=sorted(req.presets))
    return {"ok": True, "active_preset": req.active_preset}
