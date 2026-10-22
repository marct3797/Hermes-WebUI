from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .auth import assert_auth_configured
from .config import Settings, get_settings
from .profiles import ProfileRegistry
from .routes import chat
from .security import RateLimiter, SecurityMiddleware


def create_app(settings: Settings | None = None, transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    settings = settings or get_settings()
    assert_auth_configured(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.http = httpx.AsyncClient(
            timeout=settings.upstream_timeout_s, transport=transport, follow_redirects=False
        )
        yield
        await app.state.http.aclose()

    app = FastAPI(
        title="Hermes WebUI BFF", lifespan=lifespan,
        docs_url=None if settings.env == "prod" else "/bff/docs", redoc_url=None, openapi_url=None if settings.env == "prod" else "/bff/openapi.json",
    )
    app.state.settings = settings
    app.state.profiles = ProfileRegistry(settings.profiles_file)
    app.state.limiter = RateLimiter(settings.runs_per_minute)

    app.add_middleware(SecurityMiddleware, settings=settings)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.host_list())
    app.include_router(chat.router)

    @app.get("/healthz", include_in_schema=False)
    async def healthz():
        return {"ok": True}

    static = settings.static_dir
    if static and Path(static).is_dir():
        index = Path(static) / "index.html"
        app.mount("/assets", StaticFiles(directory=Path(static) / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        async def spa(path: str):
            if path.startswith("bff/"):
                raise HTTPException(404)
            candidate = (Path(static) / path).resolve()
            if path and candidate.is_file() and Path(static).resolve() in candidate.parents:
                return FileResponse(candidate)
            return FileResponse(index)

    return app


def app_factory() -> FastAPI:
    return create_app()
