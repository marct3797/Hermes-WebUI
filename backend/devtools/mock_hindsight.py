"""Hindsight-Ersatz für Tests: die Routen und Antwortformen der Hindsight-API (`/v1/default/banks/{bank}/…`).

Die Formen folgen der OpenAPI-Beschreibung und der öffentlichen Doku, noch nicht einem Lauf gegen kage:8888. Weicht die echte
Antwort ab, zeigt es die Diagnose unter /bff/memory/<id>/diagnose; die Normalisierung in app/memory.py wird dann angepasst.

Start: uvicorn devtools.mock_hindsight:app --port 8888
"""
from __future__ import annotations

import os
from typing import Any

from fastapi import FastAPI, HTTPException, Request

UNITS = [
    {"id": "u1", "text": "Marc nutzt Forgejo unter git.thiel.digital.", "context": "Setup", "date": "2026-10-20T10:00:00Z", "fact_type": "world",
     "entities": "Marc, Forgejo", "document_id": "d1", "tags": ["infra"]},
    {"id": "u2", "text": "Inari hat die WebUI-Tests ausgeführt.", "context": "Chat", "date": "2026-10-22T09:30:00Z", "fact_type": "experience",
     "entities": "Inari, WebUI", "document_id": "d2", "tags": []},
    {"id": "u3", "text": "Hikari betreibt den Container hermes-agents.", "context": None, "date": "2026-10-21T12:00:00Z", "fact_type": "world",
     "entities": "Hikari", "document_id": "d1", "tags": ["infra", "hikari"]},
]


def create_mock(require_key: str | None = None, bank: str = "hermes") -> FastAPI:
    app = FastAPI()

    @app.middleware("http")
    async def auth(request: Request, call_next):
        if require_key and request.headers.get("authorization") != f"Bearer {require_key}":
            from fastapi.responses import JSONResponse
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
        return await call_next(request)

    def check(bank_id: str) -> None:
        if bank_id != bank:
            raise HTTPException(404, "bank not found")

    base = "/v1/default/banks/{bank_id}"

    @app.get(f"{base}/stats")
    async def stats(bank_id: str):
        check(bank_id)
        return {"bank_id": bank_id, "total_nodes": 3, "total_links": 2, "total_documents": 2,
                "nodes_by_fact_type": {"world": 2, "experience": 1, "opinion": 0}, "links_by_link_type": {"entity": 2},
                "pending_operations": 0, "failed_operations": 0}

    @app.get(f"{base}/memories/list")
    async def list_units(bank_id: str, q: str | None = None, type: str | None = None, limit: int = 100, offset: int = 0):
        check(bank_id)
        rows = [u for u in UNITS if (not q or q.lower() in u["text"].lower()) and (not type or u["fact_type"] == type)]
        return {"items": rows[offset:offset + limit], "total": len(rows), "limit": limit, "offset": offset}

    @app.post(f"{base}/memories/recall")
    async def recall(bank_id: str, body: dict[str, Any]):
        check(bank_id)
        q = str(body.get("query", "")).lower()
        types = body.get("types")
        hits = [u for u in UNITS if any(w in u["text"].lower() for w in q.split()) and (not types or u["fact_type"] in types)]
        return {"results": [{"id": u["id"], "text": u["text"], "type": u["fact_type"], "context": u["context"],
                             "entities": [e.strip() for e in u["entities"].split(",")], "occurred_start": u["date"],
                             "document_id": u["document_id"], "tags": u["tags"]} for u in hits], "trace": None}

    app.state.graph_calls = []

    @app.get(f"{base}/graph")
    async def graph(bank_id: str, request: Request, limit: int = 1000, q: str | None = None, type: str | None = None):
        check(bank_id)
        app.state.graph_calls.append(dict(request.query_params))
        if os.environ.get("MOCK_GRAPH_NODES"):
            return big_graph(int(os.environ["MOCK_GRAPH_NODES"]), os.environ.get("MOCK_GRAPH_KINDS", "1") != "0")
        us = [u for u in UNITS if (not type or u["fact_type"] == type) and (not q or q.lower() in u["text"].lower())][:limit]
        ids = {u["id"] for u in us}
        links = [("u1", "u3", "entity"), ("u1", "u2", "temporal"), ("u1", "ghost", "entity"), ("u2", "u3", "caused_by")]
        return {
            "nodes": [{"data": {"id": u["id"], "label": u["text"][:30], "text": u["text"], "date": u["date"], "context": u["context"],
                                "entities": u["entities"], "color": "#ccc"}} for u in us],
            "edges": [{"data": {"id": f"{a}-{b}-{k}", "source": a, "target": b, "linkType": k, "weight": 1.0, "entityName": "", "color": "#999"}}
                      for a, b, k in links if a in ids and (b in ids or b == "ghost")],  # Kante ins Leere: wird verworfen
            "table_rows": [{"id": u["id"], "text": u["text"], "context": u["context"], "mentioned_at": u["date"], "entities": u["entities"],
                            "fact_type": u["fact_type"]} for u in us],
            "total_units": len([u for u in UNITS if not type or u["fact_type"] == type]), "limit": limit,
        }

    @app.get(f"{base}/stats/memories-timeseries")
    async def timeseries(bank_id: str, period: str = "7d", time_field: str = "created_at"):
        check(bank_id)
        return {"bank_id": bank_id, "period": period, "trunc": "day", "time_field": time_field,
                "buckets": [{"time": "2026-10-20T00:00:00+00:00", "world": 1, "experience": 0, "observation": 2},
                            {"time": "2026-10-21T00:00:00+00:00", "world": 1, "experience": 0, "observation": 0},
                            {"time": "2026-10-22T00:00:00+00:00", "world": 0, "experience": 1, "observation": 1}]}

    ENTITIES = [{"id": "en1", "canonical_name": "Marc", "mention_count": 7, "first_seen": "2026-10-01T00:00:00Z", "last_seen": "2026-10-22T00:00:00Z"},
                {"id": "en2", "canonical_name": "Hikari", "mention_count": 3, "first_seen": None, "last_seen": None}]

    @app.get(f"{base}/entities")
    async def entities(bank_id: str, limit: int = 100, offset: int = 0):
        check(bank_id)
        return {"items": ENTITIES[offset:offset + limit], "total": len(ENTITIES), "limit": limit, "offset": offset}

    @app.get(f"{base}/entities/{{entity_id}}")
    async def entity(bank_id: str, entity_id: str):
        check(bank_id)
        e = next((x for x in ENTITIES if x["id"] == entity_id), None)
        if e is None:
            raise HTTPException(404, "entity not found")
        return {**e, "observations": [{"text": f"{e['canonical_name']} taucht in mehreren Chats auf.", "mentioned_at": "2026-10-22T08:00:00Z"}]}

    @app.get(f"{base}/mental-models")
    async def mental_models(bank_id: str, limit: int = 100, offset: int = 0, detail: str = "full"):
        check(bank_id)
        return {"items": [{"id": "mm1", "name": "Infrastruktur", "source_query": "Welche Server gibt es?",
                           "content": "Hikari ist der VPS, kage hostet Hindsight.", "tags": ["infra"], "last_refreshed_at": "2026-10-22T12:00:00Z"}]}

    @app.post(f"{base}/reflect")
    async def reflect(bank_id: str, body: dict[str, Any]):
        check(bank_id)
        return {"text": f"Zu „{body.get('query')}“: Hikari betreibt den Container.", "based_on": {"world": [UNITS[2]], "experience": [], "opinion": []}}

    return app


app = create_mock()


def big_graph(n: int, kinds: bool = True) -> dict:
    """Ein Graph in der Größe eines echten Gedächtnisses (150 Knoten, rund 7.000 Kanten): Fakten teilen sich Entitäten und bilden
    dadurch dichte Gruppen („entity“), dazu zeitliche Nachbarn, Ähnlichkeiten und ein paar Ursachen. Ohne `kinds` fehlt fact_type
    wie in der echten Instanz."""
    topics = ["Marc", "Hikari", "Hermes", "Forgejo", "Tailscale", "Docker", "Hindsight", "Kanban", "Sora", "Omoikane", "Räume", "Caddy", "Laptop", "Skills"]
    sentence = ["betreibt", "nutzt", "konfiguriert", "prüft", "migriert", "dokumentiert"]
    ents: list[list[int]] = [[(i * 5 + k * 3) % len(topics) for k in range(1 + (i % 3))] for i in range(n)]
    types = ("world", "experience", "observation")
    nodes = []
    for i in range(n):
        t = topics[ents[i][0]]
        label = f"{t} {sentence[i % len(sentence)]} {topics[(ents[i][-1] + 1) % len(topics)]} (Fakt {i})"
        data = {"id": f"n{i}", "label": label, "text": label * 3, "date": f"2026-{1 + i % 10:02d}-{1 + i % 27:02d}T10:00:00+00:00", "context": f"Kontext {i % 5}",
                "entities": ", ".join(topics[k] for k in ents[i]), "color": "#f87171"}
        if kinds:
            data["fact_type"] = types[i % 3]
        nodes.append({"data": data})
    seen, edges = set(), []

    def link(a: int, b: int, kind: str) -> None:
        if a != b and (min(a, b), max(a, b), kind) not in seen:
            seen.add((min(a, b), max(a, b), kind))
            edges.append({"data": {"id": f"{kind}{len(edges)}", "source": f"n{a}", "target": f"n{b}", "linkType": kind, "weight": 1.0 - (len(edges) % 17) / 20}})

    for ent in range(len(topics)):
        members = [i for i in range(n) if ent in ents[i]]
        for x in range(len(members)):
            for y in range(x + 1, len(members)):
                link(members[x], members[y], "entity")
    for i in range(n):
        for d in (1, 2, 3):
            link(i, (i + d) % n, "temporal")
        for d in (7, 19, 31):
            link(i, (i * 3 + d) % n, "semantic")
        if i % 11 == 0:
            link(i, (i + 5) % n, "caused_by")
    return {"nodes": nodes, "edges": edges, "table_rows": [], "total_units": n}
