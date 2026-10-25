"""P3: System, Curator, Lerngraph, Darstellung, Datenschutz. Schranken siehe tests/test_hermes_insights.py.

Nicht durchgereicht: `host/identity`, `health/*`, `ssh/ownership`, `portal` (Anbindung des Desktop-Clients), `ops/dump` und `ops/debug-share`
(laden Diagnosedaten zu einem Fremddienst hoch), `ops/config-migrate`.
"""
from __future__ import annotations

import re
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from ..auth import User, current_user, fresh_user
from ..dashboard_ops import redact
from .agents import Tgt, upstream
from .dashboard import Dash, audit

router = APIRouter(prefix="/bff/h/{host}/{runtime}/{agent}", dependencies=[Depends(current_user)])

CURATOR_ACTION = "curator-run"
FONTS = ("theme", "system-sans", "system-serif", "system-mono", "inter", "ibm-plex-sans", "work-sans", "atkinson-hyperlegible", "dm-sans",
         "spectral", "fraunces", "source-serif", "jetbrains-mono", "ibm-plex-mono", "space-mono")  # Allowlist von Hermes; Schriften werden dort per URL nachgeladen
NODE_ID = re.compile(r"[\w.:@/ -]{1,200}")


def _limit(request: Request, user: User, what: str) -> None:
    request.app.state.limiter.check(f"{user.id}:{what}")


def _num(v: Any) -> Any:
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


# ---- System ----
@router.get("/hermes-system")
async def system(target: Tgt, dash: Dash):
    b = await upstream(dash.request("GET", "/api/system/stats", params={"profile": target.agent.id}))
    if not isinstance(b, dict):
        raise HTTPException(502, "Das Dashboard liefert die Systemwerte in unbekannter Form")
    out: dict[str, Any] = {k: str(b[k])[:80] for k in ("system", "release", "arch", "hostname", "python_version", "python_impl", "hermes_version") if isinstance(b.get(k), str)}
    out |= {k: _num(b.get(k)) for k in ("cpu_count", "cpu_percent", "uptime_seconds") if _num(b.get(k)) is not None}
    for k in ("memory", "disk"):  # nur Zahlen; Pfade und Umgebung bleiben draußen
        if isinstance(b.get(k), dict):
            out[k] = {kk: vv for kk, vv in b[k].items() if isinstance(kk, str) and _num(vv) is not None}
    return out


# ---- Computer Use: nur Status. Die Rechte-Vergabe (macOS) bleibt aus; `source` und `detail` zeigen Serverpfade und fehlen deshalb ----
@router.get("/hermes-computer-use")
async def computer_use(target: Tgt, dash: Dash):
    b = await upstream(dash.request("GET", "/api/tools/computer-use/status", params={"profile": target.agent.id}))
    if not isinstance(b, dict) or not isinstance(b.get("installed"), bool) or not isinstance(b.get("checks"), list):
        raise HTTPException(502, "Das Dashboard liefert den Computer-Use-Status in unbekannter Form")
    ready = b.get("ready")
    return {"platform": str(b.get("platform", ""))[:20], "platform_supported": bool(b.get("platform_supported")), "installed": b["installed"],
            "version": redact(str(b["version"]))[:120] if isinstance(b.get("version"), str) else None, "ready": ready if isinstance(ready, bool) else None,
            "checks": [{"name": str(c.get("name", ""))[:60], "ok": c.get("ok") if isinstance(c.get("ok"), bool) else None} for c in b["checks"][:20] if isinstance(c, dict)],
            "error": redact(str(b["error"]))[:300] if b.get("error") else None}


# ---- Curator ----
async def _curator(dash: Dash, agent: str) -> dict[str, Any]:
    b = await upstream(dash.request("GET", "/api/curator", params={"profile": agent}))
    if not isinstance(b, dict) or not isinstance(b.get("paused"), bool):
        raise HTTPException(502, "Das Dashboard liefert den Curator in unbekannter Form")
    return {"enabled": bool(b.get("enabled")), "paused": b["paused"], "interval_hours": _num(b.get("interval_hours")), "last_run_at": _num(b.get("last_run_at")),
            "min_idle_hours": _num(b.get("min_idle_hours")), "stale_after_days": _num(b.get("stale_after_days")), "archive_after_days": _num(b.get("archive_after_days"))}


@router.get("/hermes-curator")
async def curator_read(target: Tgt, dash: Dash):
    return await _curator(dash, target.agent.id)


class PauseIn(BaseModel):
    model_config = {"extra": "forbid"}
    paused: bool


@router.put("/hermes-curator/paused")
async def curator_pause(request: Request, target: Tgt, dash: Dash, req: PauseIn, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-insights")
    await upstream(dash.request("PUT", "/api/curator/paused", body={"paused": req.paused}, params={"profile": target.agent.id}))
    if (await _curator(dash, target.agent.id))["paused"] is not req.paused:
        raise HTTPException(502, "Das Dashboard hat den Curator nicht umgeschaltet")
    audit(request, user, "curator.paused", target, paused=req.paused)
    return {"ok": True, "paused": req.paused}


class RunIn(BaseModel):
    model_config = {"extra": "forbid"}
    confirm_archive: bool = False


@router.post("/hermes-curator/run")
async def curator_run(request: Request, target: Tgt, dash: Dash, req: RunIn, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-curator-run")
    if not req.confirm_archive:
        raise HTTPException(422, "Der Curator archiviert und überarbeitet Skills und verbraucht Tokens: confirm_archive=true senden")
    out = await upstream(dash.request("POST", "/api/curator/run", params={"profile": target.agent.id}))
    if not isinstance(out, dict) or out.get("ok") is not True:
        raise HTTPException(502, "Das Dashboard hat den Curator nicht gestartet")
    audit(request, user, "curator.run", target)
    return {"started": True, "name": CURATOR_ACTION}


@router.get("/hermes-curator/run")
async def curator_log(target: Tgt, dash: Dash):
    b = await upstream(dash.request("GET", f"/api/actions/{CURATOR_ACTION}/status", params={"profile": target.agent.id, "lines": "200"}, missing="Noch kein Lauf"))
    if not isinstance(b, dict):
        raise HTTPException(502, "Das Dashboard liefert das Protokoll in unbekannter Form")
    lines = b.get("lines") if isinstance(b.get("lines"), list) else str(b.get("log") or "").splitlines()
    text = redact("\n".join(str(x)[:300] for x in lines[-200:]))
    return {"running": bool(b.get("running")), "exit_code": b.get("exit_code") if isinstance(b.get("exit_code"), int) else None, "log": text[-6000:]}


# ---- Lerngraph ----
def _nid(v: str) -> str:
    if not NODE_ID.fullmatch(v) or ".." in v:
        raise HTTPException(422, "Knoten-ID: nur Buchstaben, Ziffern und _ . : @ / - und Leerzeichen, ohne ..")
    return v


@router.get("/hermes-learning")
async def learning_graph(target: Tgt, dash: Dash):
    b = await upstream(dash.request("GET", "/api/learning/graph", params={"profile": target.agent.id}))
    if not isinstance(b, dict) or not isinstance(b.get("nodes"), list):
        raise HTTPException(502, "Das Dashboard liefert den Lerngraph in unbekannter Form")
    nodes = [{"id": str(n.get("id"))[:200], "label": str(n.get("label", ""))[:120], "kind": str(n.get("kind", ""))[:20], "category": str(n.get("category", ""))[:60],
              "use_count": n.get("useCount") if isinstance(n.get("useCount"), int) else 0, "state": str(n.get("state", ""))[:20], "pinned": bool(n.get("pinned"))}
             for n in b["nodes"] if isinstance(n, dict) and n.get("id")][:500]
    ids = {n["id"] for n in nodes}
    edges = [{"source": str(e.get("source")), "target": str(e.get("target"))} for e in (b.get("edges") if isinstance(b.get("edges"), list) else [])
             if isinstance(e, dict) and str(e.get("source")) in ids and str(e.get("target")) in ids][:2000]
    return {"nodes": nodes, "edges": edges}


async def _node(dash: Dash, agent: str, nid: str) -> dict[str, Any]:
    b = await upstream(dash.request("GET", "/api/learning/node", params={"profile": agent, "id": nid}, missing="Diesen Knoten gibt es nicht"))
    if not isinstance(b, dict) or not isinstance(b.get("content"), str):
        raise HTTPException(502, "Das Dashboard liefert den Knoten in unbekannter Form")
    return {"id": nid, "kind": str(b.get("kind", ""))[:20], "label": str(b.get("label", ""))[:120], "content": b["content"][:100_000]}


@router.get("/hermes-learning/node")
async def node_read(target: Tgt, dash: Dash, id: str = Query(default="")):
    return await _node(dash, target.agent.id, _nid(id))


class NodeIn(BaseModel):
    model_config = {"extra": "forbid"}
    id: str
    content: str = Field(max_length=100_000)


@router.put("/hermes-learning/node")
async def node_edit(request: Request, target: Tgt, dash: Dash, req: NodeIn, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-insights")
    nid = _nid(req.id)
    if not req.content.strip():
        raise HTTPException(422, "Inhalt: leer")
    await upstream(dash.request("PUT", "/api/learning/node", body={"id": nid, "content": req.content}, params={"profile": target.agent.id}, missing="Diesen Knoten gibt es nicht"))
    now = nid
    if nid.startswith("memory:"):  # die ID einer Erinnerung trägt den Fingerabdruck ihres Textes: nach dem Speichern gilt eine neue, gleiche Quelle und Nummer
        prefix = ":".join(nid.split(":")[:3]) + ":"
        same = [n["id"] for n in (await learning_graph(target, dash))["nodes"] if n["id"].startswith(prefix)]
        if len(same) != 1:
            raise HTTPException(502, "Das Dashboard hat die Erinnerung nicht wiedergefunden")
        now = same[0]
    if (await _node(dash, target.agent.id, now))["content"].strip() != req.content.strip():
        raise HTTPException(502, "Das Dashboard hat den Inhalt nicht übernommen")
    audit(request, user, "learning.edit", target, node=nid, length=len(req.content))
    return {"ok": True, "id": now}


@router.delete("/hermes-learning/node")
async def node_delete(request: Request, target: Tgt, dash: Dash, id: str = Query(default=""), confirm: str = Query(default=""), user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-insights")
    nid = _nid(id)
    if confirm != nid:
        raise HTTPException(422, "Löschen: die Knoten-ID zur Bestätigung eingeben")
    await upstream(dash.request("DELETE", "/api/learning/node", body={"id": nid}, params={"profile": target.agent.id}, missing="Diesen Knoten gibt es nicht"))
    try:
        await _node(dash, target.agent.id, nid)
    except HTTPException as e:
        if e.status_code == 404:
            audit(request, user, "learning.delete", target, node=nid)
            return {"ok": True, "id": nid}
        raise
    raise HTTPException(502, "Das Dashboard hat den Knoten nicht gelöscht")


# ---- Darstellung (Hermes-Dashboard; die WebUI hat eigene Themes) ----
async def _appearance(dash: Dash, agent: str) -> dict[str, Any]:
    t = await upstream(dash.request("GET", "/api/dashboard/themes", params={"profile": agent}))
    f = await upstream(dash.request("GET", "/api/dashboard/font", params={"profile": agent}))
    if not isinstance(t, dict) or not isinstance(t.get("themes"), list) or not isinstance(f, dict):
        raise HTTPException(502, "Das Dashboard liefert die Darstellung in unbekannter Form")
    return {"themes": [{"name": str(x.get("name"))[:60], "label": str(x.get("label", ""))[:80], "description": str(x.get("description", ""))[:200]} for x in t["themes"] if isinstance(x, dict) and x.get("name")],
            "active": str(t.get("active", ""))[:60], "font": str(f.get("font", ""))[:40], "fonts": list(FONTS)}


@router.get("/hermes-appearance")
async def appearance_read(target: Tgt, dash: Dash):
    return await _appearance(dash, target.agent.id)


class ThemeIn(BaseModel):
    model_config = {"extra": "forbid"}
    name: str = Field(min_length=1, max_length=60)


class FontIn(BaseModel):
    model_config = {"extra": "forbid"}
    font: str = Field(max_length=40)


@router.put("/hermes-appearance/theme")
async def theme_set(request: Request, target: Tgt, dash: Dash, req: ThemeIn, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-insights")
    if req.name not in {t["name"] for t in (await _appearance(dash, target.agent.id))["themes"]}:
        raise HTTPException(422, "Theme: dieses Theme meldet das Dashboard nicht")
    await upstream(dash.request("PUT", "/api/dashboard/theme", body={"name": req.name}, params={"profile": target.agent.id}))
    if (await _appearance(dash, target.agent.id))["active"] != req.name:
        raise HTTPException(502, "Das Dashboard hat das Theme nicht übernommen")
    audit(request, user, "appearance.theme", target, theme=req.name)
    return {"ok": True, "active": req.name}


@router.put("/hermes-appearance/font")
async def font_set(request: Request, target: Tgt, dash: Dash, req: FontIn, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-insights")
    if req.font not in FONTS:
        raise HTTPException(422, "Schrift: nur aus der Liste")
    await upstream(dash.request("PUT", "/api/dashboard/font", body={"font": req.font}, params={"profile": target.agent.id}))
    if (await _appearance(dash, target.agent.id))["font"] != req.font:
        raise HTTPException(502, "Das Dashboard hat die Schrift nicht übernommen")
    audit(request, user, "appearance.font", target, font=req.font)
    return {"ok": True, "font": req.font}


# ---- Datenschutz ----
async def _consent(dash: Dash, agent: str) -> dict[str, bool]:
    b = await upstream(dash.request("GET", "/api/shared-metrics/consent", params={"profile": agent}))
    if not isinstance(b, dict) or not all(isinstance(b.get(k), bool) for k in ("enabled", "send", "decided", "managed")):
        raise HTTPException(502, "Das Dashboard liefert die Einwilligung in unbekannter Form")
    return {k: b[k] for k in ("enabled", "send", "decided", "managed")}


@router.get("/hermes-privacy")
async def privacy_read(target: Tgt, dash: Dash):
    e = await upstream(dash.request("GET", "/api/egress/status", params={"profile": target.agent.id}))
    return {"egress": redact(str(e.get("text", "")) if isinstance(e, dict) else "")[:2000], "metrics": await _consent(dash, target.agent.id)}


class MetricsIn(BaseModel):
    model_config = {"extra": "forbid"}
    enabled: bool
    send: bool = False
    confirm_send: bool = False


@router.put("/hermes-privacy/metrics")
async def metrics_set(request: Request, target: Tgt, dash: Dash, req: MetricsIn, user: User = Depends(fresh_user)):
    _limit(request, user, "hermes-insights")
    if req.send and not req.enabled:
        raise HTTPException(422, "Senden setzt Sammeln voraus")
    if req.send and not req.confirm_send:
        raise HTTPException(422, "Senden schickt Nutzungsdaten vom Rechner weg: confirm_send=true senden")
    if (await _consent(dash, target.agent.id))["managed"]:
        raise HTTPException(409, "Diese Installation wird verwaltet: die Einwilligung lässt sich hier nicht ändern")
    await upstream(dash.request("PUT", "/api/shared-metrics/consent", body={"enabled": req.enabled, "send": req.send}, params={"profile": target.agent.id}))
    now = await _consent(dash, target.agent.id)
    if now["enabled"] is not req.enabled or now["send"] is not req.send:
        raise HTTPException(502, "Das Dashboard hat die Einwilligung nicht übernommen")
    audit(request, user, "privacy.metrics", target, enabled=req.enabled, send=req.send)
    return {"ok": True, "metrics": now}
