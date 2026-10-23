"""Gedächtnis-Anbieter: eine Schnittstelle für Hindsight und, später, weitere Memory-Provider von Hermes.

Hermes selbst bietet für Memory-Provider keine gemeinsame Lese-Schnittstelle (die Plugin-Schnittstelle kennt nur Hooks und
Tools). Die WebUI spricht deshalb die REST-API des jeweiligen Dienstes an und bringt die Antworten in eine gemeinsame Form:

    Eintrag   {id, text, kind, context, entities[], at, tags[], document}
    Graph     {nodes[{id, label, kind}], edges[{source, target, label}], total}
    Entität   {id, name, mentions, first_seen, last_seen}

Welche Ansichten ein Anbieter hat, steht in `capabilities` (`stats`, `items`, `search`, `graph`, `entities`, `models`,
`reflect`); die Seite zeigt nur diese. Neuer Anbieter: Klasse von `MemoryProvider` ableiten und in `PROVIDER_TYPES` eintragen.
Lesen ist der Normalfall; geschrieben wird nicht (Hindsight füllt Hermes selbst über seinen Provider).

Die Formen für Hindsight folgen der OpenAPI-Beschreibung und der öffentlichen Doku; die Normalisierung ist deshalb tolerant,
und die Diagnose (`/bff/memory/<id>/diagnose`) meldet, was sie nicht erkennt.
"""
from __future__ import annotations

import json
import os
import re
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

from .adapters import UpstreamError

ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
BANK_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
OBJ_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")


@dataclass(frozen=True)
class MemoryCfg:
    id: str
    type: str
    label: str
    base_url: str
    bank: str
    api_key: str = field(default="", repr=False)  # nie in Logs oder Antworten


class MemoryRegistry:
    """`memory.json` (siehe memory.example.json), bei Änderung ohne Neustart neu gelesen. Fehlt die Datei, gibt es keine Anbieter."""

    def __init__(self, path: Path | None, environ: Mapping[str, str] | None = None):
        self.path, self._environ = path, environ if environ is not None else os.environ
        self.error: str | None = None
        self._mtime: float | None = None
        self._providers: dict[str, MemoryCfg] = {}

    def providers(self) -> dict[str, MemoryCfg]:
        if self.path is None:
            return {}
        try:
            mtime = self.path.stat().st_mtime
        except FileNotFoundError:
            self._providers, self._mtime, self.error = {}, None, None
            return self._providers
        if mtime != self._mtime:
            self._mtime = mtime
            try:
                self._providers = parse_memory_config(json.loads(self.path.read_text("utf-8")), self._environ)
                self.error = None
            except (ValueError, OSError) as e:
                self.error = f"memory.json: {e}"  # die letzte gültige Fassung bleibt
        return self._providers


def parse_memory_config(raw: Any, environ: Mapping[str, str]) -> dict[str, MemoryCfg]:
    if not isinstance(raw, dict) or not isinstance(raw.get("providers"), list):
        raise ValueError('erwartet {"providers": [...]}')
    out: dict[str, MemoryCfg] = {}
    for p in raw["providers"]:
        if not isinstance(p, dict):
            raise ValueError("Eintrag ist kein Objekt")
        pid = str(p.get("id", ""))
        if not ID_RE.match(pid):
            raise ValueError(f"ungültige id {pid!r}")
        if pid in out:
            raise ValueError(f"id {pid!r} doppelt")
        ptype = str(p.get("type", ""))
        if ptype not in PROVIDER_TYPES:
            raise ValueError(f"unbekannter Typ {ptype!r} (bekannt: {', '.join(sorted(PROVIDER_TYPES))})")
        base = str(p.get("base_url", "")).rstrip("/")
        if not base.startswith(("http://", "https://")):
            raise ValueError(f"{pid}: base_url muss mit http:// oder https:// beginnen")
        bank = str(p.get("bank", "hermes"))
        if not BANK_RE.match(bank):
            raise ValueError(f"{pid}: ungültige bank")
        key_env = p.get("api_key_env")
        out[pid] = MemoryCfg(pid, ptype, str(p.get("label") or pid), base, bank, environ.get(str(key_env), "") if key_env else "")
    return out


# --- Normalisierung ----------------------------------------------------------------------------------
def _s(v: Any) -> str | None:
    return v.strip() if isinstance(v, str) and v.strip() else None


def _first(d: Mapping[str, Any], *keys: str) -> Any:
    for k in keys:
        if d.get(k) not in (None, ""):
            return d[k]
    return None


def _ms(v: Any) -> int | None:
    if isinstance(v, (int, float)) and v > 0:
        return int(v * 1000) if v < 1e11 else int(v)
    if isinstance(v, str) and v:
        try:
            return int(datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            return None
    return None


def _rows(payload: Any, *keys: str) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict):
        rows = next((payload[k] for k in (*keys, "items", "results", "data") if isinstance(payload.get(k), list)), [])
    else:
        rows = []
    return [r for r in rows if isinstance(r, dict)]


def _names(v: Any) -> list[str]:
    """Entitäten kommen als Liste von Namen, Liste von Objekten oder als kommagetrennter Text."""
    if isinstance(v, str):
        return [p.strip() for p in v.split(",") if p.strip()]
    if isinstance(v, list):
        out = []
        for e in v:
            n = _s(e) if isinstance(e, str) else _s(_first(e, "canonical_name", "name", "text") if isinstance(e, dict) else None)
            if n:
                out.append(n)
        return out
    return []


def norm_item(r: dict[str, Any]) -> dict[str, Any] | None:
    text = _s(_first(r, "text", "content", "fact", "memory", "summary"))
    if text is None:
        return None
    tags = r.get("tags")
    return {
        "id": str(_first(r, "id", "unit_id", "uuid") or text[:40]),
        "text": text,
        "kind": _s(_first(r, "fact_type", "type", "kind")),
        "context": _s(r.get("context")),
        "entities": _names(r.get("entities")),
        "at": _ms(_first(r, "occurred_start", "mentioned_at", "date", "created_at", "timestamp")),
        "tags": [t for t in tags if isinstance(t, str)] if isinstance(tags, list) else [],
        "document": _s(r.get("document_id")),
    }


def norm_items(payload: Any) -> list[dict[str, Any]]:
    return [i for i in (norm_item(r) for r in _rows(payload, "results", "memories", "facts")) if i]


def norm_entities(payload: Any) -> list[dict[str, Any]]:
    out = []
    for r in _rows(payload, "entities"):
        name = _s(_first(r, "canonical_name", "name", "text"))
        if name:
            out.append({"id": str(_first(r, "id", "entity_id") or name), "name": name,
                        "mentions": int(_first(r, "mention_count", "mentions", "count") or 0),
                        "first_seen": _ms(r.get("first_seen")), "last_seen": _ms(r.get("last_seen"))})
    return out


def norm_graph(payload: Any, cap: int) -> dict[str, Any]:
    """Cytoscape-artige Elemente (`{"data": {...}}`) und flache Listen gleichermaßen."""
    p = payload if isinstance(payload, dict) else {}

    def data(e: Any) -> dict[str, Any]:
        return e["data"] if isinstance(e, dict) and isinstance(e.get("data"), dict) else e if isinstance(e, dict) else {}

    nodes, ids = [], set()
    for e in p.get("nodes", []) if isinstance(p.get("nodes"), list) else []:
        d = data(e)
        nid = _first(d, "id")
        if nid is None or str(nid) in ids:
            continue
        ids.add(str(nid))
        nodes.append({"id": str(nid), "label": _s(_first(d, "label", "name", "text")) or str(nid)[:12], "kind": _s(_first(d, "fact_type", "type", "kind"))})
    edges = []
    for e in p.get("edges", []) if isinstance(p.get("edges"), list) else []:
        d = data(e)
        a, b = _first(d, "source", "from"), _first(d, "target", "to")
        if a is not None and b is not None and str(a) in ids and str(b) in ids:
            edges.append({"source": str(a), "target": str(b), "label": _s(_first(d, "label", "link_type", "linkType", "type"))})
    total = _first(p, "total_units", "total", "total_nodes")
    kept = nodes[:cap]
    keep_ids = {n["id"] for n in kept}
    return {"nodes": kept, "edges": [e for e in edges if e["source"] in keep_ids and e["target"] in keep_ids],
            "total": int(total) if isinstance(total, (int, float)) else len(nodes), "truncated": len(nodes) > cap}


def norm_stats(payload: Any) -> list[dict[str, Any]]:
    """Zähler als Liste {label, value}: Zahlen auf oberster Ebene und Aufschlüsselungen (`nodes_by_fact_type` …)."""
    if not isinstance(payload, dict):
        return []
    out: list[dict[str, Any]] = []
    for k, v in payload.items():
        if isinstance(v, bool):
            continue
        if isinstance(v, (int, float)):
            out.append({"key": k, "value": v})
        elif isinstance(v, dict):
            out.extend({"key": f"{k}.{kk}", "value": vv} for kk, vv in v.items() if isinstance(vv, (int, float)) and not isinstance(vv, bool))
    return out


def norm_models(payload: Any) -> list[dict[str, Any]]:
    out = []
    for r in _rows(payload, "mental_models", "models"):
        name = _s(_first(r, "name", "title", "id"))
        if name:
            out.append({"id": str(_first(r, "id") or name), "name": name, "content": _s(_first(r, "content", "text", "summary")),
                        "query": _s(_first(r, "source_query", "query")), "updated": _ms(_first(r, "last_refreshed_at", "updated_at", "created_at")),
                        "tags": [t for t in r.get("tags", []) if isinstance(t, str)] if isinstance(r.get("tags"), list) else []})
    return out


# --- Anbieter ----------------------------------------------------------------------------------------
class MemoryProvider:
    type = ""
    capabilities: tuple[str, ...] = ()

    def __init__(self, cfg: MemoryCfg, http: httpx.AsyncClient):
        self.cfg, self._http = cfg, http

    def public(self) -> dict[str, Any]:
        return {"id": self.cfg.id, "type": self.type, "label": self.cfg.label, "bank": self.cfg.bank, "capabilities": list(self.capabilities)}

    async def stats(self) -> list[dict[str, Any]]:
        raise NotImplementedError

    async def items(self, q: str | None, kind: str | None, limit: int, offset: int) -> dict[str, Any]:
        raise NotImplementedError

    async def search(self, q: str, kind: str | None, limit: int) -> list[dict[str, Any]]:
        raise NotImplementedError

    async def graph(self, q: str | None, limit: int) -> dict[str, Any]:
        raise NotImplementedError

    async def entities(self, limit: int, offset: int) -> dict[str, Any]:
        raise NotImplementedError

    async def entity(self, entity_id: str) -> dict[str, Any]:
        raise NotImplementedError

    async def models(self) -> list[dict[str, Any]]:
        raise NotImplementedError

    async def reflect(self, query: str) -> dict[str, Any]:
        raise NotImplementedError

    async def diagnose(self) -> list[dict[str, Any]]:
        raise NotImplementedError


class HindsightProvider(MemoryProvider):
    """Hindsight (vectorize-io): Wissensgraph mit Entitäten, Fakten, Beobachtungen und mentalen Modellen. Routen unter `/v1/default/banks/{bank}`."""

    type = "hindsight"
    capabilities = ("stats", "items", "search", "graph", "entities", "models", "reflect")

    async def _call(self, method: str, path: str, **kw: Any) -> Any:
        headers = {"Accept": "application/json"}
        if self.cfg.api_key:
            headers["Authorization"] = f"Bearer {self.cfg.api_key}"
        url = f"{self.cfg.base_url}/v1/default/banks/{self.cfg.bank}{path}"
        try:
            r = await self._http.request(method, url, headers=headers, timeout=20.0, **kw)
        except httpx.TimeoutException as e:
            raise UpstreamError(504, "Hindsight antwortet nicht rechtzeitig") from e
        except httpx.HTTPError as e:
            raise UpstreamError(502, "Hindsight nicht erreichbar") from e
        if r.status_code >= 400:
            raise UpstreamError(502 if r.status_code in (401, 403) else r.status_code, f"Hindsight: {r.text[:200]}")
        try:
            return r.json()
        except ValueError as e:
            raise UpstreamError(502, "Hindsight lieferte kein JSON") from e

    async def stats(self) -> list[dict[str, Any]]:
        return norm_stats(await self._call("GET", "/stats"))

    async def items(self, q: str | None, kind: str | None, limit: int, offset: int) -> dict[str, Any]:
        params: dict[str, Any] = {"limit": limit, "offset": offset}
        if q:
            params["q"] = q
        if kind:
            params["type"] = kind
        payload = await self._call("GET", "/memories/list", params=params)
        total = payload.get("total") if isinstance(payload, dict) else None
        return {"items": norm_items(payload), "total": total if isinstance(total, int) else None, "limit": limit, "offset": offset}

    async def search(self, q: str, kind: str | None, limit: int) -> list[dict[str, Any]]:
        body: dict[str, Any] = {"query": q, "budget": "low", "max_tokens": 2048}
        if kind:
            body["types"] = [kind]
        return norm_items(await self._call("POST", "/memories/recall", json=body))[:limit]

    async def graph(self, q: str | None, limit: int) -> dict[str, Any]:
        params: dict[str, Any] = {"limit": limit}
        if q:
            params["q"] = q
        return norm_graph(await self._call("GET", "/graph", params=params), limit)

    async def entities(self, limit: int, offset: int) -> dict[str, Any]:
        payload = await self._call("GET", "/entities", params={"limit": limit, "offset": offset})
        total = payload.get("total") if isinstance(payload, dict) else None
        return {"items": norm_entities(payload), "total": total if isinstance(total, int) else None, "limit": limit, "offset": offset}

    async def entity(self, entity_id: str) -> dict[str, Any]:
        payload = await self._call("GET", f"/entities/{entity_id}")
        base = (norm_entities([payload]) or [{"id": entity_id, "name": entity_id, "mentions": 0, "first_seen": None, "last_seen": None}])[0]
        obs = [i for i in norm_items(payload.get("observations") if isinstance(payload, dict) and isinstance(payload.get("observations"), list) else []) if i]
        return {**base, "observations": obs}

    async def models(self) -> list[dict[str, Any]]:
        return norm_models(await self._call("GET", "/mental-models", params={"limit": 100, "detail": "full"}))

    async def reflect(self, query: str) -> dict[str, Any]:
        payload = await self._call("POST", "/reflect", json={"query": query, "budget": "low"})
        text = _s(_first(payload, "text", "answer", "response")) if isinstance(payload, dict) else None
        based = payload.get("based_on") if isinstance(payload, dict) else None
        used = []
        if isinstance(based, dict):
            for group in based.values():
                used += norm_items(group if isinstance(group, list) else [])
        elif isinstance(based, list):
            used = norm_items(based)
        return {"text": text or "", "based_on": used[:20]}

    async def diagnose(self) -> list[dict[str, Any]]:
        """Fasst zusammen, ob die Antworten erkannt werden. Nur lesend; `ms` je Prüfung."""
        out: list[dict[str, Any]] = []

        async def one(cid: str, label: str, fn) -> None:
            started = time.monotonic()
            try:
                status, detail = await fn()
            except UpstreamError as e:
                status, detail = "fail", f"{e.status}: {e.detail}"
            out.append({"id": cid, "label": label, "status": status, "detail": detail, "ms": round((time.monotonic() - started) * 1000)})

        async def stats():
            rows = await self.stats()
            return ("ok", f"{len(rows)} Zähler") if rows else ("warn", "Keine Zähler erkannt (Form der Statistik unbekannt)")

        async def items():
            r = await self.items(None, None, 5, 0)
            if r["items"]:
                return "ok", f"{len(r['items'])} Einträge gelesen, insgesamt {r['total'] if r['total'] is not None else '?'}"
            return "warn", "Keine Einträge erkannt (Bank leer oder Form der Liste unbekannt)"

        async def graph():
            g = await self.graph(None, 50)
            if g["nodes"]:
                return "ok", f"{len(g['nodes'])} Knoten, {len(g['edges'])} Kanten"
            return "warn", "Keine Knoten erkannt (Bank leer oder Form des Graphen unbekannt)"

        async def entities():
            r = await self.entities(5, 0)
            return ("ok", f"{len(r['items'])} Entitäten gelesen") if r["items"] else ("warn", "Keine Entitäten erkannt")

        await one("stats", "Statistik", stats)
        await one("items", "Fakten lesen", items)
        await one("graph", "Graph", graph)
        await one("entities", "Entitäten", entities)
        return out


PROVIDER_TYPES: dict[str, type[MemoryProvider]] = {"hindsight": HindsightProvider}
