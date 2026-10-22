"""Minimaler Hermes-API-Server-Ersatz für Entwicklung und Tests.

Bildet nur die Chat-relevanten Routen nach (Format nach Doku-Zusammenfassung, nicht gegen echtes
Hermes geprüft). Prompt-Stichworte steuern das Szenario: "tool" -> Tool-Aufruf,
"approval" -> Freigabe-Anfrage, "clarify" -> Rückfrage, "fail" -> Fehler.

Start: uvicorn devtools.mock_hermes:app --port 8642
"""
from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

from fastapi import FastAPI, HTTPException, Request

API_KEY = "dev-key"


def create_mock(wait_for_user: bool = True, delay: float = 0.03, require_key: bool = True) -> FastAPI:
    app = FastAPI()
    sessions: dict[str, dict[str, Any]] = {}
    runs: dict[str, dict[str, Any]] = {}

    @app.middleware("http")
    async def auth(request: Request, call_next):
        from fastapi.responses import JSONResponse
        if require_key and request.headers.get("authorization") != f"Bearer {API_KEY}":
            return JSONResponse({"error": {"message": "Invalid API key"}}, status_code=401)
        return await call_next(request)

    def prefixless(path: str) -> str:
        return path

    @app.get("/v1/capabilities")
    async def caps():
        return {"version": "mock-0.1", "features": {"runs": True, "reasoning_stream": True}}

    @app.get("/api/model/options")
    async def model_options():
        return {"models": [{"id": "mock-large", "provider": "mock"}, {"id": "mock-small", "provider": "mock"}],
                "current": "mock-large"}

    @app.get("/api/sessions")
    async def list_sessions(limit: int = 30, offset: int = 0, source: str | None = None):
        items = [
            {"id": sid, "title": s["title"], "source": s.get("source", "chat"), "updated_at": s["updated_at"],
             "message_count": len(s["messages"])}
            for sid, s in sessions.items() if source in (None, s.get("source", "chat"))
        ]
        items.sort(key=lambda x: x["updated_at"], reverse=True)
        return {"sessions": items[offset:offset + limit], "total": len(items)}

    @app.get("/api/sessions/{sid}/messages")
    async def messages(sid: str):
        if sid not in sessions:
            raise HTTPException(404, "session not found")
        return {"messages": sessions[sid]["messages"]}

    @app.post("/v1/runs", status_code=202)
    async def start(request: Request):
        body = await request.json()
        text = body["input"] if isinstance(body["input"], str) else next(
            p["text"] for p in body["input"][0]["content"] if p["type"] == "text")
        sid = body.get("session_id") or f"sess_{uuid.uuid4().hex[:8]}"
        s = sessions.setdefault(sid, {"title": text[:40], "messages": [], "updated_at": 0})
        s["messages"].append({"role": "user", "content": text})
        s["updated_at"] = len(sessions) + sum(len(x["messages"]) for x in sessions.values())
        rid = f"run_{uuid.uuid4().hex[:8]}"
        runs[rid] = {"status": "running", "text": text, "session_id": sid,
                     "approval": asyncio.Event(), "clarify": asyncio.Event(), "answer": None, "stop": asyncio.Event()}
        return {"run_id": rid, "session_id": sid, "status": "running"}

    @app.get("/v1/runs/{rid}")
    async def status(rid: str):
        if rid not in runs:
            raise HTTPException(404, "run not found")
        return {"run_id": rid, "status": runs[rid]["status"], "session_id": runs[rid]["session_id"]}

    @app.post("/v1/runs/{rid}/stop")
    async def stop(rid: str):
        runs[rid]["stop"].set()
        return {"status": "stopping"}

    @app.post("/v1/runs/{rid}/approval")
    async def approval(rid: str, request: Request):
        runs[rid]["answer"] = (await request.json())["decision"]
        runs[rid]["approval"].set()
        return {"ok": True}

    @app.post("/v1/runs/{rid}/clarify")
    async def clarify(rid: str, request: Request):
        runs[rid]["answer"] = (await request.json())["answer"]
        runs[rid]["clarify"].set()
        return {"ok": True}

    def ev(name: str, data: dict) -> str:
        return f"event: {name}\ndata: {json.dumps(data)}\n\n"

    @app.get("/v1/runs/{rid}/events")
    async def events(rid: str):
        from fastapi.responses import StreamingResponse
        if rid not in runs:
            raise HTTPException(404, "run not found")
        r = runs[rid]
        text = r["text"].lower()

        async def gen():
            yield ev("run.started", {"run_id": rid, "session_id": r["session_id"]})
            if "fail" in text:
                yield ev("run.failed", {"error": "Mock-Fehler"})
                r["status"] = "failed"
                return
            if "tool" in text:
                yield ev("tool.started", {"tool_call_id": "t1", "name": "terminal", "preview": "ls -la"})
                await asyncio.sleep(delay)
                yield ev("tool.completed", {"tool_call_id": "t1", "name": "terminal", "duration_ms": 41,
                                            "output": "total 0\nREADME.md"})
            if "approval" in text:
                yield ev("approval.requested", {"approval_id": "a1", "command": "rm -rf build/",
                                                "reason": "Löscht Dateien", "timeout": 300})
                if wait_for_user:
                    await r["approval"].wait()
                    if r["answer"] == "deny":
                        yield ev("run.failed", {"error": "Freigabe abgelehnt"})
                        r["status"] = "failed"
                        return
            if "clarify" in text:
                yield ev("clarify.requested", {"clarify_id": "c1", "question": "Welcher Ordner?",
                                               "choices": ["build", "dist"]})
                if wait_for_user:
                    await r["clarify"].wait()
            yield ev("reasoning.delta", {"delta": "Ich überlege kurz. "})
            reply = "Hallo! Das ist eine **Mock-Antwort** mit `Code` und Liste:\n\n- eins\n- zwei\n\n```py\nprint('hi')\n```\n"
            for chunk in [reply[i:i + 12] for i in range(0, len(reply), 12)]:
                if r["stop"].is_set():
                    yield ev("run.stopped", {})
                    r["status"] = "stopped"
                    return
                yield ev("assistant.delta", {"delta": chunk})
                await asyncio.sleep(delay)
            sessions[r["session_id"]]["messages"].append({"role": "assistant", "content": reply})
            r["status"] = "completed"
            yield ev("run.completed", {"usage": {"input_tokens": 12, "output_tokens": 34}})

        return StreamingResponse(gen(), media_type="text/event-stream")

    return app


app = create_mock()
