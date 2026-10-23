"""Minimaler Hermes-API-Server-Ersatz für Entwicklung und Tests.

Spricht die Formen, die Hermes 0.21.6 auf Hikari tatsächlich liefert (Memory `hermes-api-real-0-21-6`): reine
`data:`-Frames ohne `event:`-Zeile, Eventname im JSON-Feld `event`, `POST /v1/runs` ohne `session_id` (steht im
Lauf-Status), Listen als `{object, data[], has_more}`, Verlauf mit `tool_calls` und Rolle `tool`, Fähigkeiten
als `features`-Flags, Modelle als `providers[]`. `tool.completed` trägt keine Ausgabe: die steht erst im Verlauf.
Der Strom ist wie bei Hermes nur einmal abonnierbar.

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
    profiles: tuple[str, ...] = ("default", "omoikane"), multiplex: bool = True, with_steer: bool = True,
) -> FastAPI:
    app = FastAPI()
    # Zustand je Profil: Sessions und Runs sind getrennt, wie bei echten Profilen.
    state: dict[str, dict[str, Any]] = {p: {"sessions": {}, "runs": {}, "keys": {}} for p in profiles}

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
        flags = {
            "chat_completions": True, "responses_api": True, "run_submission": True,
            "runs_idempotency": {"supported": True, "durable": True, "retention_seconds": 86400},
            "run_status": True, "run_events_sse": True, "run_stop": True, "run_steer": with_steer,
            "run_approval_response": True, "tool_progress_events": True, "approval_events": True,
            "session_resources": True, "model_options": True, "session_chat": True, "session_fork": True,
            "session_model_lock": True, "reasoning_streaming": True, "skills_api": True,
            "admin_config_rw": False, "jobs_admin": False, "memory_write_api": False,
            "audio_api": False, "realtime_voice": False,
        }
        return {"object": "hermes.api_server.capabilities", "platform": "hermes-agent", "model": "hermes-agent",
                "auth": {"type": "bearer", "required": True}, "features": flags, "endpoints": {}}

    @router.get("/api/model/options")
    async def model_options():
        return {
            "providers": [
                {"slug": "mock", "name": "Mock", "is_current": True, "authenticated": True,
                 "models": ["mock-large", "mock-small"], "featured_models": ["mock-large"]},
                {"slug": "nous", "name": "Nous", "is_current": False, "authenticated": False, "models": []},
            ],
            "model": "mock-large", "provider": "mock",
        }

    @router.get("/api/sessions")
    async def list_sessions(request: Request, limit: int = 30, offset: int = 0, source: str | None = None):
        sessions = store(request)["sessions"]
        items = [
            {"id": sid, "source": s.get("source", "chat"), "user_id": None, "model": "mock-large", "title": s["title"],
             "started_at": s["started_at"], "last_active": s["updated_at"], "preview": s["title"],
             "message_count": len(s["messages"]), "pinned": False, "archived": False, "hidden": False}
            for sid, s in sessions.items() if source in (None, s.get("source", "chat"))
        ]
        items.sort(key=lambda x: x["last_active"], reverse=True)
        page = items[offset:offset + limit]
        return {"object": "list", "data": page, "limit": limit, "offset": offset, "has_more": offset + limit < len(items)}

    def message_page(sid: str, session: dict[str, Any], limit: int | None, offset: int) -> dict[str, Any]:
        everything = [{"id": i + 1, **m} for i, m in enumerate(session["messages"])]
        page = everything[offset:] if limit is None else everything[offset:offset + limit]
        return {"object": "list", "session_id": sid, "data": page,
                "pagination": {"limit": limit, "offset": offset, "total": len(everything),
                               "has_more": limit is not None and offset + limit < len(everything)}}

    @router.get("/api/sessions/{sid}/messages")
    async def messages(request: Request, sid: str, limit: int | None = None, offset: int = 0):
        sessions = store(request)["sessions"]
        if sid not in sessions:
            raise HTTPException(404, "session not found")
        return message_page(sid, sessions[sid], limit, offset)

    @router.patch("/api/sessions/{sid}")
    async def rename(request: Request, sid: str):
        sessions = store(request)["sessions"]
        if sid not in sessions:
            raise HTTPException(404, "session not found")
        title = (await request.json()).get("title")
        if not isinstance(title, str) or not title.strip():
            raise HTTPException(400, "title required")
        if any(o["title"] == title for k, o in sessions.items() if k != sid):
            raise HTTPException(409, "title_conflict")  # Titel sind eindeutig
        sessions[sid]["title"] = title
        return {"object": "hermes.session", "id": sid, "title": title}

    @router.delete("/api/sessions/{sid}")
    async def remove(request: Request, sid: str):
        st = store(request)
        if sid not in st["sessions"]:
            raise HTTPException(404, "session not found")
        if any(r["session_id"] == sid and r["status"] in ("running", "waiting_for_approval") for r in st["runs"].values()):
            raise HTTPException(409, "session_busy")
        del st["sessions"][sid]
        return {"deleted": True, "id": sid}

    @router.post("/api/sessions/{sid}/fork")
    async def fork(request: Request, sid: str):
        sessions = store(request)["sessions"]
        if sid not in sessions:
            raise HTTPException(404, "session not found")
        new = f"run_{uuid.uuid4().hex[:32]}"
        now = time.time()
        sessions[new] = {**sessions[sid], "messages": [dict(m) for m in sessions[sid]["messages"]],
                         "title": f"{sessions[sid]['title']} (Zweig)", "started_at": now, "updated_at": now}
        return {"object": "hermes.session", "session": {"id": new}}

    @router.post("/v1/runs", status_code=202)
    async def start(request: Request):
        st = store(request)
        body = await request.json()
        if "input" not in body:
            raise HTTPException(400, "input required")
        key = request.headers.get("idempotency-key")
        if key and key in st["keys"]:
            return {"run_id": st["keys"][key], "status": "started", "replayed": True}
        text = body["input"] if isinstance(body["input"], str) else next(
            p["text"] for p in body["input"][0]["content"] if p["type"] == "text")
        sid = body.get("session_id") or f"run_{uuid.uuid4().hex[:32]}"
        now = time.time()
        s = st["sessions"].setdefault(sid, {"title": text[:40], "messages": [], "started_at": now, "updated_at": 0})
        s["messages"].append({"role": "user", "content": text, "timestamp": now})
        s["updated_at"] = now  # Sekunden wie bei Hermes
        rid = f"run_{uuid.uuid4().hex[:8]}"
        st["runs"][rid] = {
            "status": "running", "text": text, "session_id": sid, "subscribed": False, "answer": None,
            "approval": asyncio.Event(), "steer": asyncio.Event(), "steer_text": None, "stop": asyncio.Event(),
        }
        if key:
            st["keys"][key] = rid
        return {"run_id": rid, "status": "started", "replayed": False}  # ohne session_id, wie Hermes 0.21.6

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
                # Wie bei Hermes: Argumente und Ausgabe stehen erst im Verlauf, nicht im Ereignisstrom.
                call = f"call_{uuid.uuid4().hex[:8]}"
                now = time.time()
                sessions[r["session_id"]]["messages"] += [
                    {"role": "assistant", "content": "", "timestamp": now, "finish_reason": "tool_calls",
                     "tool_calls": [{"id": call, "type": "function", "function": {"name": "terminal", "arguments": '{"command": "ls -la"}'}}]},
                    {"role": "tool", "tool_call_id": call, "tool_name": "terminal", "timestamp": now,
                     "content": json.dumps({"output": "total 8\ndrwxr-xr-x 2 mock mock 4096 .\n-rw-r--r-- 1 mock mock   12 notes.txt", "exit_code": 0})},
                ]
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
            sessions[r["session_id"]]["messages"].append(
                {"role": "assistant", "content": reply, "reasoning": "Ich überlege kurz. ", "timestamp": time.time()})
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
