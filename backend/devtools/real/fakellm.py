"""Minimaler OpenAI-kompatibler Server (Streaming) als Modell für echte Hermes-Agents. Antwortet je nach Rolle im Prompt."""
import json, re, sys, time, uuid
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, JSONResponse
import uvicorn

import os
MODE = os.environ.get("FAKE_MODE", "")
app = FastAPI()
LOG = open(sys.argv[2], "a") if len(sys.argv) > 2 else sys.stderr

def last_user(messages):
    for m in reversed(messages):
        if m.get("role") == "user":
            c = m["content"]
            return c if isinstance(c, str) else " ".join(p.get("text", "") for p in c if isinstance(p, dict))
    return ""

def reply_for(text: str) -> str:
    me = (re.search(r"Du bist „([^“]+)“", text) or [None, "?"])[1]
    fresh = text.split("Neu im Raum seit deinem letzten Beitrag:")[-1]
    from_other = re.search(r"^(Eta|Beta): ", fresh, re.M)
    if me == "Eta":
        if from_other:
            return "Danke dir, Beta. Dann fasse ich es zusammen."
        return "Ich habe es gelesen. @Beta, kannst du das bitte prüfen? Ich fasse es dann für @user zusammen."
    if me == "Beta":
        return "@Eta habe es geprüft: Das stimmt so." if from_other else "[PASS]"
    return "[PASS]"

@app.post("/v1/chat/completions")
async def chat(req: Request):
    body = await req.json()
    text = last_user(body["messages"])
    msgs = body["messages"]
    out = reply_for(text)
    tool_result = msgs and msgs[-1].get("role") == "tool"
    if body.get("tools") and not tool_result and MODE == "tools" and "direkt angesprochen" in text:
        # erst ein Werkzeug aufrufen (echter Agent mit Terminal), danach die Antwort
        cid = f"chatcmpl-{uuid.uuid4().hex[:8]}"
        call = {"id": "call_1", "type": "function", "function": {"name": "terminal", "arguments": json.dumps({"command": "echo geprueft"})}}
        LOG.write(json.dumps({"tool_call": "terminal", "prompt": text[:200]}) + "\n"); LOG.flush()
        if not body.get("stream"):
            return JSONResponse({"id": cid, "object": "chat.completion", "created": 0, "model": "fake", "choices": [{"index": 0, "message": {"role": "assistant", "content": None, "tool_calls": [call]}, "finish_reason": "tool_calls"}], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})
        def g():
            yield "data: " + json.dumps({"id": cid, "object": "chat.completion.chunk", "created": 0, "model": "fake", "choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [{"index": 0, **call}]}, "finish_reason": None}]}) + "\n\n"
            yield "data: " + json.dumps({"id": cid, "object": "chat.completion.chunk", "created": 0, "model": "fake", "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]}) + "\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(g(), media_type="text/event-stream")
    LOG.write(json.dumps({"stream": body.get("stream"), "tools": bool(body.get("tools")), "prompt": text[:400], "tail": text[-500:], "out": out}, ensure_ascii=False) + "\n"); LOG.flush()
    cid, now = f"chatcmpl-{uuid.uuid4().hex[:8]}", int(time.time())
    if not body.get("stream"):
        return JSONResponse({"id": cid, "object": "chat.completion", "created": now, "model": "fake",
                             "choices": [{"index": 0, "message": {"role": "assistant", "content": out}, "finish_reason": "stop"}],
                             "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20}})
    def gen():
        for i in range(0, len(out), 8):
            yield "data: " + json.dumps({"id": cid, "object": "chat.completion.chunk", "created": now, "model": "fake", "choices": [{"index": 0, "delta": {"role": "assistant", "content": out[i:i+8]}, "finish_reason": None}]}) + "\n\n"
            time.sleep(0.05)
        yield "data: " + json.dumps({"id": cid, "object": "chat.completion.chunk", "created": now, "model": "fake", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20}}) + "\n\n"
        yield "data: [DONE]\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream")

@app.get("/v1/models")
async def models():
    return {"object": "list", "data": [{"id": "fake", "object": "model"}]}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[1]), log_level="warning")
