"""RAG-Ersatz mit Chunk-Texten: wie mock_rag, aber Chroma `get` kennt `where`/`ids`/`include documents`, `/delete` löscht nach IDs, und Einspeisen teilt
den Text in überlappende Chunks (damit Volltext und Ersetzen realistisch getestet werden).

`app.state.chunks`: Liste von {"id", "meta", "text"}. `app.state.calls`: (Pfad, Body). `app.state.fail_ingest` / `app.state.fail_chroma_delete`: Status, mit dem
die Aktion scheitert; `app.state.ingest_noop`: Einspeisen meldet Erfolg, speichert aber nichts.

Start: uvicorn devtools.mock_rag2:app --port 8000
"""
from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException

COLLECTION = "hermes-rag-m3"
CID = "11111111-1111-1111-1111-111111111111"
SIZE, OVERLAP = 60, 25  # Zeichen je Chunk, Überlappung
INTRO_TEXT = " ".join(f"Wort{i:02d}" for i in range(30))  # nicht periodisch: die Überlappung ist eindeutig


def split(text: str, size: int = SIZE, overlap: int = OVERLAP) -> list[str]:
    out, i = [], 0
    while i < len(text):
        out.append(text[i:i + size])
        if i + size >= len(text):
            break
        i += size - overlap
    return out


def create_mock(docs: dict[str, tuple[dict[str, Any], str]] | None = None) -> FastAPI:
    """docs: sync_id -> (Metadaten ohne sync_id, Text); Standard: ein Repo-Dokument und ein manuelles."""
    docs = docs if docs is not None else {
        "docs:guide/intro.md": ({"source": "docs", "repo": "example-org/docs", "path": "guide/intro.md", "commit": "a" * 40}, INTRO_TEXT),
        "manual:notiz": ({"source": "manual", "title": "Notiz"}, "Alpha beta gamma. Delta epsilon zeta eta theta iota kappa lambda my ny xi omikron pi rho sigma tau."),
    }
    app = FastAPI()
    app.state.chunks = []
    app.state.calls = []
    app.state.fail_ingest = None
    app.state.fail_chroma_delete = None
    app.state.ingest_noop = False
    app.state.seq = 0

    def add(meta: dict[str, Any], text: str) -> int:
        parts = split(text)
        for part in parts:
            app.state.seq += 1
            app.state.chunks.append({"id": f"{app.state.seq:08d}-0000-0000-0000-000000000000", "meta": dict(meta), "text": part})
        return len(parts)

    for sid, (meta, text) in docs.items():
        add({**meta, "sync_id": sid}, text)

    def note(path: str, body: Any = None) -> None:
        app.state.calls.append((path, body))

    @app.get("/api/v1/stats")
    async def stats():
        note("/api/v1/stats")
        return {"collection": COLLECTION, "count": len(app.state.chunks), "embedding_model": "BAAI/bge-m3", "chunk_size": 512, "chunk_overlap": 50}

    @app.post("/api/v1/query")
    async def query(body: dict[str, Any]):
        note("/api/v1/query", body)
        words = str(body["query"]).lower().split()
        hits = [{"content": c["text"], "score": 0.8 - i / 100, "metadata": c["meta"]} for i, c in enumerate(app.state.chunks)
                if (not body.get("source") or c["meta"].get("source") == body["source"]) and any(w in c["text"].lower() for w in words)]
        return {"query": body["query"], "results": hits[: body.get("top_k", 8)]}

    @app.post("/api/v1/ingest")
    async def ingest(body: dict[str, Any]):
        note("/api/v1/ingest", body)
        if app.state.fail_ingest:
            raise HTTPException(app.state.fail_ingest, "kaputt")
        if app.state.ingest_noop:
            return {"status": "ok", "chunks": 0}
        return {"status": "ok", "chunks": add(body["metadata"], body["text"])}

    @app.post("/api/v1/delete")
    async def delete(body: dict[str, Any]):
        note("/api/v1/delete", body)
        before = len(app.state.chunks)
        app.state.chunks = [c for c in app.state.chunks if not all(c["meta"].get(k) == v for k, v in body["where"].items())]
        return {"status": "ok", "deleted": before - len(app.state.chunks)}

    @app.get("/api/v1/collections")
    async def collections():
        note("/api/v1/collections")
        return [{"id": CID, "name": COLLECTION, "metadata": None}]

    @app.post("/api/v1/collections/{cid}/get")
    async def get(cid: str, body: dict[str, Any]):
        note(f"/api/v1/collections/{cid}/get", body)
        if cid != CID:
            raise HTTPException(404, "collection not found")
        rows = [c for c in app.state.chunks if all(c["meta"].get(k) == v for k, v in (body.get("where") or {}).items())]
        o, n = int(body.get("offset", 0)), int(body.get("limit", 1000))
        page = rows[o:o + n]
        inc = body.get("include") or []
        return {"ids": [c["id"] for c in page], "embeddings": None, "metadatas": [c["meta"] for c in page] if "metadatas" in inc else None,
                "documents": [c["text"] for c in page] if "documents" in inc else None, "uris": None, "data": None}

    @app.post("/api/v1/collections/{cid}/delete")
    async def chroma_delete(cid: str, body: dict[str, Any]):
        note(f"/api/v1/collections/{cid}/delete", body)
        if app.state.fail_chroma_delete:
            raise HTTPException(app.state.fail_chroma_delete, "kaputt")
        gone = [c["id"] for c in app.state.chunks if c["id"] in set(body.get("ids") or [])]
        app.state.chunks = [c for c in app.state.chunks if c["id"] not in gone]
        return gone

    return app


app = create_mock()
