"""Hindsight-Ersatz für Tests: die Routen und Antwortformen der Hindsight-API (`/v1/default/banks/{bank}/…`).

Die Formen folgen der OpenAPI-Beschreibung und der öffentlichen Doku, noch nicht einem Lauf gegen kage:8888. Weicht die echte
Antwort ab, zeigt es die Diagnose unter /bff/memory/<id>/diagnose; die Normalisierung in app/memory.py wird dann angepasst.

Start: uvicorn devtools.mock_hindsight:app --port 8888
"""
from __future__ import annotations

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

    @app.get(f"{base}/graph")
    async def graph(bank_id: str, limit: int = 1000, q: str | None = None):
        check(bank_id)
        return {
            "nodes": [{"data": {"id": u["id"], "label": u["text"][:30], "color": "#ccc", "fact_type": u["fact_type"]}} for u in UNITS],
            "edges": [{"data": {"id": "e1", "source": "u1", "target": "u3", "linkType": "entity"}},
                      {"data": {"id": "e2", "source": "u1", "target": "u2", "linkType": "temporal"}},
                      {"data": {"id": "e3", "source": "u1", "target": "ghost", "linkType": "entity"}}],  # Kante ins Leere: wird verworfen
            "table_rows": [], "total_units": len(UNITS),
        }

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
