"""Development-only host daemon; synthetic fixtures, never provider/model calls."""
import base64
import hashlib

from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import Response

TOKEN = "test-hostd-token-not-a-live-secret-123456"
TERMINAL = {"id": "term-1", "cli": "codex", "workspace": "repo", "pid": 123,
            "running": True, "created_at": 1}


def create_mock():
    app = FastAPI()
    app.state.calls = []
    app.state.terminals = {}
    app.state.files = {"README.md": b"fake development workspace\n", "report.pdf": b"%PDF-1.4\n"}
    app.state.dirs = {"src"}
    app.state.enabled = True
    app.state.sources = []
    app.state.jobs = {}
    app.state.jobs_admin = True
    app.state.fail = None
    app.state.unavailable = False

    @app.middleware("http")
    async def authenticate(request: Request, call_next):
        app.state.calls.append({"method": request.method, "path": request.url.path,
                                "query": str(request.url.query), "headers": dict(request.headers)})
        if request.headers.get("authorization") != f"Bearer {TOKEN}":
            return Response(status_code=401)
        if app.state.fail:
            return Response(status_code=app.state.fail)
        return await call_next(request)

    @app.get("/v1/info")
    async def info():
        return {"version": "test", "clis": [{"id": "codex", "label": "Codex", "available": True,
                "authenticated": None}], "workspaces": [{"id": "repo", "label": "Repo"}]}

    @app.get("/v1/auth")
    async def auth(refresh: int = 0):
        return {"clis": [{"id": "codex", "state": "signed_in", "method": "ChatGPT",
                          "checked_at": "2026-01-01T00:00:00+00:00", "reason": None}]}

    @app.get("/v1/terminals")
    async def terminals():
        return {"terminals": list(app.state.terminals.values())}

    @app.post("/v1/terminals")
    async def open_terminal(request: Request):
        data = await request.json()
        app.state.terminals["term-1"] = {**TERMINAL, "cli": data["cli"], "workspace": data["workspace"]}
        return app.state.terminals["term-1"]

    @app.delete("/v1/terminals/{id}")
    async def close_terminal(id: str):
        if id not in app.state.terminals:
            raise HTTPException(404)
        app.state.terminals[id]["running"] = False
        return {"ok": True}

    @app.websocket("/v1/terminals/{id}/stream")
    async def stream(ws: WebSocket, id: str):
        app.state.calls.append({"method": "WS", "path": ws.url.path, "query": ws.url.query,
                                "headers": dict(ws.headers)})
        if ws.headers.get("authorization") != f"Bearer {TOKEN}":
            await ws.close(code=4401)
            return
        await ws.accept()
        await ws.send_json({"type": "output", "data": base64.b64encode(b"test output").decode(), "offset": 11})
        try:
            while True:
                frame = await ws.receive_json()
                await ws.send_json({"type": "state", "terminal": TERMINAL, "received": frame})
        except Exception:
            pass

    @app.get("/v1/workspaces")
    async def workspaces():
        return {"workspaces": [{"id": "repo", "label": "Repo", "is_git": True}]}

    def digest(data: bytes):
        return hashlib.sha256(data).hexdigest()

    @app.get("/v1/files")
    async def files(workspace: str, path: str = "", full: bool = False):
        if path in app.state.dirs or path == "":
            prefix = path + "/" if path else ""
            names = {p[len(prefix):].split("/")[0]: (p[len(prefix):].count("/") > 0) for p in app.state.files if p.startswith(prefix)}
            names.update({d[len(prefix):].split("/")[0]: True for d in app.state.dirs if d.startswith(prefix) and d != path})
            return {"workspace": workspace, "path": path, "entries": [
                {"name": n, "path": prefix + n, "kind": "directory" if isdir else "file",
                 "size": 0 if isdir else len(app.state.files[prefix + n]), "mtime": 1} for n, isdir in sorted(names.items())]}
        if path not in app.state.files:
            raise HTTPException(404)
        data = app.state.files[path]
        return {"workspace": workspace, "path": path, "entries": [], "content": data.decode(), "truncated": False,
                "sha256": digest(data), "size": len(data), "editable": True, "mime": "text/plain", "mtime": 1}

    @app.post("/v1/files/mkdir")
    async def mkdir(request: Request):
        data = await request.json()
        if data["path"] in app.state.dirs or data["path"] in app.state.files:
            raise HTTPException(409)
        app.state.dirs.add(data["path"])
        return {"ok": True, "path": data["path"]}

    @app.put("/v1/files/write")
    async def write(request: Request):
        data = await request.json()
        path, content = data["path"], data["content"].encode()
        exists = path in app.state.files
        if data.get("create"):
            if exists:
                raise HTTPException(409)
        elif not exists:
            raise HTTPException(404)
        elif data.get("expected_sha256") != digest(app.state.files[path]):
            raise HTTPException(409)
        app.state.files[path] = content
        return {"ok": True, "path": path, "sha256": digest(content), "size": len(content)}

    @app.post("/v1/files/move")
    async def move(request: Request):
        data = await request.json()
        src, dst = data["from"], data["to"]
        if dst in app.state.files or dst in app.state.dirs:
            raise HTTPException(409)
        if src not in app.state.files:
            raise HTTPException(404)
        app.state.files[dst] = app.state.files.pop(src)
        return {"ok": True, "from": src, "to": dst}

    @app.get("/v1/files/download")
    async def download(workspace: str, path: str):
        return Response(app.state.files[path], headers={"Content-Disposition": 'inline; filename="evil.html"',
                        "Set-Cookie": "evil=1", "X-Untrusted": "bad"}, media_type="text/html")

    @app.post("/v1/files/upload")
    async def upload(request: Request):
        data = await request.json()
        if data["path"] in app.state.files:
            raise HTTPException(409, "exists")
        content = base64.b64decode(data["content_base64"])
        app.state.files[data["path"]] = content
        return {"ok": True, "path": data["path"], "size": len(content)}

    @app.get("/v1/git")
    async def git(workspace: str):
        return {"branch": "main", "status": "", "diff": "", "remotes": [], "truncated": False,
                "files": [{"path": "README.md", "state": "M"}], "log": [{"hash": "a" * 40, "subject": "Erster Stand",
                "author": "Alpha", "date": "2026-01-01T00:00:00+00:00"}], "branches": [{"name": "main", "current": True}]}

    @app.get("/v1/search")
    async def search(q: str):
        return {"results": [{"profile": "default", "session_id": "session-1", "title": "Test",
                             "snippet": q}], "truncated": False}

    @app.get("/v1/manage")
    async def manage():
        return {"profiles": [{"id": "default"}], "clis": [], "sources": app.state.sources}

    @app.get("/v1/manage/{profile}/{kind}")
    async def management(profile: str, kind: str):
        if app.state.unavailable:  # wie ein Host-Dienst ohne native Anbindung
            return {"available": False, "reason": "Native Kanban adapter not configured", "items": [], "actions": []}
        return {"profile": profile, "kind": kind, "items": [], "enabled": app.state.enabled}

    @app.post("/v1/manage/{profile}/{kind}/{action}")
    async def management_write(profile: str, kind: str, action: str, request: Request):
        app.state.enabled = action == "enable"
        return {"ok": True}

    # Hermes API fixture on the same isolated server, including multiplex routing.
    @app.get("/p/default/v1/capabilities")
    async def capabilities():
        return {"features": {"jobs_admin": app.state.jobs_admin}}

    @app.api_route("/p/default/api/jobs", methods=["GET", "POST"])
    async def jobs(request: Request):
        if request.method == "GET":
            return {"jobs": list(app.state.jobs.values())}
        job = {"id": "abcdef123456", **await request.json()}
        app.state.jobs[job["id"]] = job
        return {"job": job}

    @app.api_route("/p/default/api/jobs/{id}", methods=["GET", "PATCH", "DELETE"])
    async def job(request: Request, id: str):
        if id not in app.state.jobs:
            raise HTTPException(404)
        if request.method == "DELETE":
            del app.state.jobs[id]
            return {"ok": True}
        if request.method == "PATCH":
            app.state.jobs[id].update(await request.json())
        return {"job": app.state.jobs[id]}

    @app.post("/p/default/api/jobs/{id}/{action}")
    async def job_action(id: str, action: str):
        app.state.jobs[id]["paused"] = action == "pause"
        return {"job": app.state.jobs[id]}

    return app


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(create_mock(), host="127.0.0.1", port=8766)
