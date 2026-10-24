"""RAG-Ersatz für Tests: der Wissensdienst (`/api/v1/stats|query|ingest|delete`) und der Chroma-v1-Teil (`collections`, `get` mit Paging).

Die Formen entsprechen den bereinigten Mitschnitten in backend/tests/fixtures/real/. Die Antwort von `/api/v1/delete` ist beim echten Dienst
nicht erfasst; `delete_body` legt sie fest. `app.state.calls` hält jede Anfrage (Pfad, Body), `app.state.chunks` die Metadaten der Chunks.

Start: uvicorn devtools.mock_rag:app --port 8000
"""
from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException

COLLECTION = "hermes-rag-m3"
CHUNKS = [{"source": "docs", "repo": "example-org/docs", "path": f"guide/{n}.md", "commit": "a" * 40, "sync_id": f"docs:guide/{n}.md"} for n in ("intro", "intro", "setup")]


def create_mock(chunks: list[dict[str, Any] | None] | None = None, results: list[dict[str, Any]] | None = None, delete_body: Any = None,
                collection: str = COLLECTION) -> FastAPI:
    app = FastAPI()
    app.state.chunks = list(CHUNKS if chunks is None else chunks)
    app.state.calls = []
    app.state.fail = None  # z. B. 500: jede Anfrage scheitert mit diesem Status

    def note(path: str, body: Any = None) -> None:
        app.state.calls.append((path, body))
        if app.state.fail:
            raise HTTPException(app.state.fail, "kaputt")

    @app.get("/api/v1/stats")
    async def stats():
        note("/api/v1/stats")
        return {"collection": collection, "count": len(app.state.chunks), "embedding_model": "BAAI/bge-m3", "chunk_size": 512, "chunk_overlap": 50}

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.post("/api/v1/query")
    async def query(body: dict[str, Any]):
        note("/api/v1/query", body)
        if results is not None:
            return {"query": body["query"], "results": results}
        words = str(body["query"]).lower().split()
        hits = [{"content": f"Text zu {m.get('path') or m.get('title')}", "score": 0.7 - i / 100, "metadata": m}
                for i, m in enumerate(app.state.chunks) if m and (not body.get("source") or m.get("source") == body["source"]) and any(w in str(m).lower() for w in words)]
        return {"query": body["query"], "results": hits[: body.get("top_k", 8)]}

    @app.post("/api/v1/ingest")
    async def ingest(body: dict[str, Any]):
        note("/api/v1/ingest", body)
        app.state.chunks.append(body.get("metadata"))
        return {"status": "ok", "chunks": 1}

    @app.post("/api/v1/delete")
    async def delete(body: dict[str, Any]):
        note("/api/v1/delete", body)
        where = body["where"]
        before = len(app.state.chunks)
        app.state.chunks = [m for m in app.state.chunks if not (m and all(m.get(k) == v for k, v in where.items()))]
        return delete_body if delete_body is not None else {"status": "ok", "deleted": before - len(app.state.chunks)}

    @app.get("/api/v1/collections")
    async def collections():
        note("/api/v1/collections")
        return [{"id": "11111111-1111-1111-1111-111111111111", "name": collection, "metadata": None}]

    @app.post("/api/v1/collections/{cid}/get")
    async def get(cid: str, body: dict[str, Any]):
        note(f"/api/v1/collections/{cid}/get", body)
        if cid != "11111111-1111-1111-1111-111111111111":
            raise HTTPException(404, "collection not found")
        o, n = int(body.get("offset", 0)), int(body.get("limit", 1000))
        page = app.state.chunks[o:o + n]
        return {"ids": [f"{o + i:08d}-0000-0000-0000-000000000000" for i in range(len(page))], "embeddings": None, "metadatas": page, "documents": None, "uris": None, "data": None}

    return app


app = create_mock()
