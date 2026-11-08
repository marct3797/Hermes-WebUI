"""Forgejo-Ersatz für Tests: die Issue-Routen von /api/v1 (Liste, Detail, Anlegen, Ändern, Labels, Kommentare) mit Token-Prüfung.

Formen nach der Forgejo/Gitea-API (Issue: number, title, body, state, labels[], assignees[], user, comments, html_url, pull_request).
`app.state.calls` hält jede Anfrage (Methode, Pfad, Body). Start: uvicorn devtools.mock_forgejo:app --port 3000
"""
from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException, Request

TOKEN = "test-token"


def _issue(n: int, title: str, state: str = "open", labels: tuple[str, ...] = (), pr: bool = False, assignee: str | None = None) -> dict[str, Any]:
    return {"number": n, "title": title, "body": f"Text zu {title}", "state": state, "html_url": f"https://git.test/o/r/issues/{n}",
            "labels": [{"name": x, "color": "e11d48"} for x in labels], "assignees": [{"login": assignee}] if assignee else [], "user": {"login": "marc"},
            "comments": 0, "created_at": "2026-11-01T10:00:00Z", "updated_at": "2026-11-02T10:00:00Z", **({"pull_request": {"merged": False}} if pr else {})}


def create_mock(token: str = TOKEN) -> FastAPI:
    app = FastAPI()
    app.state.calls = []
    app.state.issues = {"o/r": [_issue(1, "Offen"), _issue(2, "In Arbeit", labels=("in-progress",), assignee="marc"), _issue(3, "Fertig", state="closed"),
                                _issue(4, "Ein Pull-Request", pr=True)]}
    app.state.comments = {"o/r/2": [{"id": 9, "user": {"login": "marc"}, "body": "Erster Kommentar", "created_at": "2026-11-02T11:00:00Z"}]}

    @app.middleware("http")
    async def record(request: Request, call_next):
        body = None
        if request.method in ("POST", "PATCH", "PUT"):
            try:
                body = await request.json()
            except Exception:
                body = None
        if request.headers.get("authorization") != f"token {token}":
            from fastapi.responses import JSONResponse
            return JSONResponse({"message": "token is required"}, status_code=401)
        app.state.calls.append((request.method, request.url.path, body))
        return await call_next(request)

    def find(owner: str, repo: str, number: int) -> dict[str, Any]:
        for i in app.state.issues.get(f"{owner}/{repo}", []):
            if i["number"] == number:
                return i
        raise HTTPException(404, "not found")

    @app.get("/api/v1/repos/{owner}/{repo}/issues")
    async def lst(owner: str, repo: str, state: str = "open", page: int = 1, limit: int = 50):
        if f"{owner}/{repo}" not in app.state.issues:
            raise HTTPException(404, "not found")
        rows = [i for i in app.state.issues[f"{owner}/{repo}"] if state == "all" or i["state"] == state]
        return rows[(page - 1) * limit: page * limit]

    @app.get("/api/v1/repos/{owner}/{repo}/issues/{number}")
    async def one(owner: str, repo: str, number: int):
        return find(owner, repo, number)

    @app.get("/api/v1/repos/{owner}/{repo}/issues/{number}/comments")
    async def comments(owner: str, repo: str, number: int):
        return app.state.comments.get(f"{owner}/{repo}/{number}", [])

    @app.post("/api/v1/repos/{owner}/{repo}/issues/{number}/comments", status_code=201)
    async def add_comment(owner: str, repo: str, number: int, body: dict):
        find(owner, repo, number)
        app.state.comments.setdefault(f"{owner}/{repo}/{number}", []).append({"id": 99, "user": {"login": "marc"}, "body": body["body"], "created_at": "2026-11-03T10:00:00Z"})
        return {"id": 99}

    @app.post("/api/v1/repos/{owner}/{repo}/issues", status_code=201)
    async def create(owner: str, repo: str, body: dict):
        rows = app.state.issues[f"{owner}/{repo}"]
        n = max(i["number"] for i in rows) + 1
        issue = _issue(n, body["title"], labels=tuple(body.get("labels") or ()), assignee=(body.get("assignees") or [None])[0])
        issue["body"] = body.get("body", "")
        rows.append(issue)
        return issue

    @app.patch("/api/v1/repos/{owner}/{repo}/issues/{number}")
    async def patch(owner: str, repo: str, number: int, body: dict):
        i = find(owner, repo, number)
        for k in ("title", "body", "state"):
            if k in body:
                i[k] = body[k]
        if "assignees" in body:
            i["assignees"] = [{"login": a} for a in body["assignees"]]
        return i

    @app.put("/api/v1/repos/{owner}/{repo}/issues/{number}/labels")
    async def labels(owner: str, repo: str, number: int, body: dict):
        i = find(owner, repo, number)
        i["labels"] = [{"name": x, "color": "e11d48"} for x in body["labels"]]
        return i["labels"]

    @app.get("/api/v1/repos/{owner}/{repo}/labels")
    async def repo_labels(owner: str, repo: str):
        return [{"name": "in-progress", "color": "e11d48"}, {"name": "review", "color": "0ea5e9"}]

    return app


app = create_mock()
