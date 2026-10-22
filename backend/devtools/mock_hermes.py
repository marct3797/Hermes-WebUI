"""Minimaler Hermes-API-Server-Ersatz für Entwicklung und Tests.

Spricht das Format, das die Quelltext-Lesung von Hermes 0.20.4 ergibt (Fakten-Datei im Projekt):
reine `data:`-Frames ohne `event:`-Zeile, Eventname im JSON-Feld `event`, `approval.request` mit
`choices`, Freigabe-Antwort `{"choice": …}`, `/health` ohne Key, Profile unter `/p/<profil>/…`.
Der Strom ist wie bei Hermes nur einmal abonnierbar. Noch nicht gegen eine laufende Instanz geprüft.

Prompt-Stichworte steuern das Szenario: "tool" -> Tool-Aufruf, "approval" -> Freigabe-Anfrage,
"smart" -> Freigabe mit smart_denied, "fail" -> Fehler, "steer" -> wartet auf Steer.

Start: uvicorn devtools.mock_hermes:app --port 8642   (Key: dev-key)
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Any

from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

API_KEY = "dev-key"
VERSION = "0.20.4-mock"


def create_mock(
    wait_for_user: bool = True, delay: float = 0.03, require_key: bool = True,
    profiles: tuple[str, ...] = ("default", "omoikane"), multiplex: bool = True,
) -> FastAPI:
    app = FastAPI()
    # Zustand je Profil: Sessions und Runs sind getrennt, wie bei echten Profilen.
    state: dict[str, dict[str, Any]] = {p: {"sessions": {}, "runs": {}} for p in profiles}

    @app.middleware("http")
    async def auth(request: Request, call_next):
        if require_key and request.url.path != "/health" and request.headers.get("authorization") != f"Bearer {API_KEY}":
            return JSONResponse({"error": {"message": "Invalid API key", "code": "gateway_auth_error"}}, status_code=401)
        return await call_next(request)

    @app.get("/health")
    async def health():
        return {"status": "ok", "platform": "hermes-agent", "version": VERSION}

    router = APIRouter()

    def store(request: Request) -> dict[str, Any]:
        profile = request.path_params.get("profile", "default") if multiplex else "default"
        if profile not in state:
            raise HTTPException(404, "profile not found")
        return state[profile]

    @router.get("/v1/capabilities")
    async def caps(request: Request):
        store(request)  # unbekanntes Profil -> 404
        return {"memory_write_api": False, "admin_config_rw": False, "jobs_admin": False, "runs": True}

    @router.get("/api/model/options")
    async def model_options():
        return {"models": [{"id": "mock-large", "provider": "mock"}, {"id": "mock-small", "provider": "mock"}],
                "current": "mock-large"}

    @router.get("/api/sessions")
    async def list_sessions(request: Request, limit: int = 30, offset: int = 0, source: str | None = None):
        sessions = store(request)["sessions"]
        items = [
            {"id": sid, "title": s["title"], "source": s.get("source", "chat"), "updated_at": s["updated_at"],
             "message_count": len(s["messages"])}
            for sid, s in sessions.items() if source in (None, s.get("source", "chat"))
        ]
        items.sort(key=lambda x: x["updated_at"], reverse=True)
        return {"sessions": items[offset:offset + limit], "total": len(items)}

    @router.get("/api/sessions/{sid}/messages")
    async def messages(request: Request, sid: str):
        sessions = store(request)["sessions"]
        if sid not in sessions:
            raise HTTPException(404, "session not found")
        return {"messages": sessions[sid]["messages"]}

    @router.post("/v1/runs", status_code=202)
    async def start(request: Request):
        st = store(request)
        body = await request.json()
        if "input" not in body:
            raise HTTPException(400, "input required")
        text = body["input"] if isinstance(body["input"], str) else next(
            p["text"] for p in body["input"][0]["content"] if p["type"] == "text")
        sid = body.get("session_id") or f"sess_{uuid.uuid4().hex[:8]}"
        s = st["sessions"].setdefault(sid, {"title": text[:40], "messages": [], "updated_at": 0})
        s["messages"].append({"role": "user", "content": text})
        s["updated_at"] = time.time()  # Sekunden wie bei Hermes
        rid = f"run_{uuid.uuid4().hex[:8]}"
        st["runs"][rid] = {
            "status": "running", "text": text, "session_id": sid, "subscribed": False, "answer": None,
            "approval": asyncio.Event(), "steer": asyncio.Event(), "steer_text": None, "stop": asyncio.Event(),
        }
        return {"run_id": rid, "session_id": sid, "status": "running"}

    def run_of(request: Request, rid: str) -> dict[str, Any]:
        r = store(request)["runs"].get(rid)
        if r is None:
            raise HTTPException(404, "run_not_found")
        return r

    @router.get("/v1/runs/{rid}")
    async def status(request: Request, rid: str):
        r = run_of(request, rid)
        return {"run_id": rid, "status": r["status"], "session_id": r["session_id"]}

    @router.post("/v1/runs/{rid}/stop")
    async def stop(request: Request, rid: str):
        run_of(request, rid)["stop"].set()
        return {"run_id": rid, "status": "stopping"}

    @router.post("/v1/runs/{rid}/approval")
    async def approval(request: Request, rid: str):
        r = run_of(request, rid)
        choice = (await request.json()).get("choice")
        if choice not in ("once", "session", "always", "deny"):
            raise HTTPException(400, "invalid_approval_choice")
        if r["status"] != "waiting_for_approval":
            raise HTTPException(409, "approval_not_active")
        r["answer"] = choice
        r["approval"].set()
        return {"ok": True}

    @router.post("/v1/runs/{rid}/steer")
    async def steer(request: Request, rid: str):
        r = run_of(request, rid)
        if r["status"] != "running":
            raise HTTPException(409, "run_not_accepting_steer")
        r["steer_text"] = (await request.json()).get("input")
        r["steer"].set()
        return {"object": "hermes.run.steer", "accepted": True}

    def ev(name: str, **data: Any) -> str:
        return f"data: {json.dumps({'event': name, 'timestamp': time.time(), **data})}\n\n"

    @router.get("/v1/runs/{rid}/events")
    async def events(request: Request, rid: str):
        r = run_of(request, rid)
        if r["subscribed"]:
            raise HTTPException(404, "run_not_found")  # nur einmal abonnierbar
        r["subscribed"] = True
        sessions = store(request)["sessions"]
        text = r["text"].lower()

        async def gen():
            run_id = rid
            if "fail" in text:
                yield ev("run.failed", run_id=run_id, error="Mock-Fehler")
                r["status"] = "failed"
                return
            if "tool" in text:
                yield ev("tool.started", run_id=run_id, tool="terminal", preview="ls -la")
                await asyncio.sleep(delay)
                yield ev("tool.completed", run_id=run_id, tool="terminal", duration=0.041, error=False)
            if "approval" in text or "smart" in text:
                smart = "smart" in text
                r["status"] = "waiting_for_approval"
                yield ev("approval.request", run_id=run_id, command="rm -rf build/", description="Löscht Dateien",
                         pattern_key="rm-rf", choices=["once", "deny"] if smart else ["once", "session", "deny"],
                         **({"smart_denied": True} if smart else {}))
                if wait_for_user:
                    await r["approval"].wait()
                    yield ev("approval.responded", run_id=run_id, choice=r["answer"], resolved=1)
                    r["status"] = "running"
                    if r["answer"] == "deny":
                        yield ev("run.failed", run_id=run_id, error="Freigabe abgelehnt")
                        r["status"] = "failed"
                        return
            if "steer" in text and wait_for_user:
                await r["steer"].wait()
                yield ev("run.steered", run_id=run_id, accepted=True)
            yield ev("reasoning.available", run_id=run_id, text="Ich überlege kurz. ")
            reply = "Hallo! Das ist eine **Mock-Antwort** mit `Code` und Liste:\n\n- eins\n- zwei\n\n```py\nprint('hi')\n```\n"
            for chunk in [reply[i:i + 12] for i in range(0, len(reply), 12)]:
                if r["stop"].is_set():
                    yield ev("run.cancelled", run_id=run_id)
                    r["status"] = "stopped"
                    return
                yield ev("message.delta", run_id=run_id, delta=chunk)
                await asyncio.sleep(delay)
            sessions[r["session_id"]]["messages"].append({"role": "assistant", "content": reply})
            r["status"] = "completed"
            yield ev("run.completed", run_id=run_id, output=reply,
                     usage={"input_tokens": 12, "output_tokens": 34, "total_tokens": 46})
            yield ": stream closed\n\n"

        return StreamingResponse(gen(), media_type="text/event-stream")

    app.include_router(router)
    if multiplex:
        app.include_router(router, prefix="/p/{profile}")
    return app


app = create_mock()
