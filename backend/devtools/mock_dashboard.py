"""Dashboard-Ersatz für Tests: die Profil-Routen von `hermes dashboard` (Form nach Hermes 0.19, Quelltext hermes_cli/web_server.py).

Gilt für `GET /api/profiles`, `GET|PUT /api/profiles/{name}/soul`, `PUT .../description` und `PUT .../model`. Unbekannte Profile
liefern 404, ein falscher Token 401. `drop_writes=True` quittiert das Schreiben, speichert aber nichts (Test für die Rücklese-Kontrolle).

Start: uvicorn devtools.mock_dashboard:app --port 9122
"""
from __future__ import annotations

import os
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

TOKEN = "dash-token"
SOULS = {
    "default": "Du bist ein hilfsbereiter Assistent.\n",
    "omoikane": "# Omoikane\n\nDu bewahrst Wissen und antwortest knapp.\n",
}


class SoulBody(BaseModel):
    content: str


class DescriptionBody(BaseModel):
    description: str = ""


class ModelBody(BaseModel):
    provider: str
    model: str


def create_mock(token: str | None = None, profiles: tuple[str, ...] = ("default", "omoikane", "sora"), drop_writes: bool = False) -> FastAPI:
    app = FastAPI()
    state: dict[str, dict[str, Any]] = {
        name: {"soul": SOULS.get(name), "description": "", "description_auto": False, "provider": "anthropic", "model": "claude-test"}
        for name in profiles
    }
    app.state.profiles = state  # Tests lesen und ändern den Stand direkt

    @app.middleware("http")
    async def auth(request: Request, call_next):
        if token and request.headers.get("x-hermes-session-token") != token:
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)
        return await call_next(request)

    def profile(name: str) -> dict[str, Any]:
        if name not in state:
            raise HTTPException(404, "Profile not found")
        return state[name]

    @app.get("/api/profiles")
    async def list_profiles():
        return {"profiles": [
            {"name": n, "path": f"/opt/data/profiles/{n}", "is_default": n == "default", "model": p["model"], "provider": p["provider"],
             "has_env": True, "skill_count": 12, "gateway_running": False, "description": p["description"],
             "description_auto": p["description_auto"], "distribution_name": None, "distribution_version": None,
             "distribution_source": None, "has_alias": False}
            for n, p in state.items()
        ]}

    @app.get("/api/profiles/{name}/soul")
    async def get_soul(name: str):
        soul = profile(name)["soul"]
        return {"content": soul or "", "exists": soul is not None}

    @app.put("/api/profiles/{name}/soul")
    async def put_soul(name: str, body: SoulBody):
        p = profile(name)
        if not drop_writes:
            p["soul"] = body.content
        return {"ok": True}

    @app.put("/api/profiles/{name}/description")
    async def put_description(name: str, body: DescriptionBody):
        p = profile(name)
        p["description"], p["description_auto"] = body.description.strip(), False
        return {"ok": True, "description": p["description"], "description_auto": False}

    @app.put("/api/profiles/{name}/model")
    async def put_model(name: str, body: ModelBody):
        p = profile(name)
        if not body.provider.strip() or not body.model.strip():
            raise HTTPException(400, "provider and model are required")
        p["provider"], p["model"] = body.provider.strip(), body.model.strip()
        return {"ok": True, "provider": p["provider"], "model": p["model"]}

    return app


# Wie das echte Dashboard: ein gesetzter HERMES_DASHBOARD_SESSION_TOKEN macht den Token zur Pflicht.
app = create_mock(token=os.environ.get("HERMES_DASHBOARD_SESSION_TOKEN"))
