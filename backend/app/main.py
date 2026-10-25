from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .access_logging import CredentialQueryFilter
from .audit import AuditLog
from .auth import SessionStore, assert_auth_configured
from .config import Settings, get_settings
from .cache import TtlCache
from .dashboard import CacheCfg, SoulHistory
from .hosts import HostService
from .oidc import OidcClient
from .registry import AGENT_RE, Registry
from .knowledge import KnowledgeRegistry
from .memory import MemoryRegistry
from .routes import composer as composer_routes, cron as cron_routes, extensions as extensions_routes, hermes_config as config_routes, tools as tools_routes, messaging as messaging_routes, hermes_memory as hermes_memory_routes, lifecycle as lifecycle_routes, kanban as kanban_routes, marketplace as marketplace_routes, models as models_routes, endpoints as endpoints_routes
from .rooms import RoomService
from .routes import agents, auth, cli_auth, dashboard as dashboard_routes, hosts, knowledge as knowledge_routes, memory as memory_routes, operations as operations_routes, rooms as rooms_routes, ui as ui_routes
from .redaction import RedactionMiddleware
from .quota import RefreshGate
from .security import RateLimiter, SecurityMiddleware
from .ui import UiConfig
from .static import FingerprintedFiles


# Unter dieser Adresse lief früher eine andere Anwendung mit Service Worker. Er bleibt im Browser registriert, fängt
# Anfragen ab und scheitert an der Weiterleitung zur Anmeldung. Diese Datei ersetzt ihn beim nächsten Update-Check:
# sie hat keinen fetch-Handler, leert die Caches, meldet sich ab und lädt offene Fenster neu.
RETIRE_SERVICE_WORKER = """\
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try { for (const key of await caches.keys()) await caches.delete(key); } catch (e) { /* ohne Cache-API */ }
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: "window" })) client.navigate(client.url);
  })());
});
"""


def create_app(
    settings: Settings | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
    oidc_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    """`transport` ersetzt die Verbindung zu den Runtimes, `oidc_transport` die zum OIDC-Anbieter (für Tests)."""
    settings = settings or get_settings()
    assert_auth_configured(settings)
    # OAuth-Codes dürfen nie in Betriebslogs landen; idempotent für wiederholte App-Erzeugung in Tests.
    access_logger = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, CredentialQueryFilter) for f in access_logger.filters):
        access_logger.addFilter(CredentialQueryFilter())

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.http = httpx.AsyncClient(
            timeout=settings.upstream_timeout_s, transport=transport, follow_redirects=False,
            limits=httpx.Limits(max_connections=100, max_keepalive_connections=20, keepalive_expiry=settings.upstream_keepalive_s),
        )
        app.state.hosts = HostService(
            app.state.registry, app.state.http,
            health_ttl=settings.health_ttl_s, health_timeout=settings.health_timeout_s,
        )
        app.state.rooms = RoomService(settings.rooms_db, app.state.hosts.target)
        oidc_http = httpx.AsyncClient(timeout=10.0, transport=oidc_transport, follow_redirects=False)
        app.state.oidc = OidcClient(settings, oidc_http)
        yield
        await app.state.rooms.shutdown()
        await app.state.http.aclose()
        await oidc_http.aclose()

    app = FastAPI(
        title="Hermes WebUI BFF", lifespan=lifespan,
        docs_url=None if settings.env == "prod" else "/bff/docs", redoc_url=None,
        openapi_url=None if settings.env == "prod" else "/bff/openapi.json",
    )
    app.state.settings = settings
    app.state.diag_cache = TtlCache()
    app.state.dash_cache = CacheCfg(TtlCache(), settings.dash_models_ttl_s, settings.dash_state_ttl_s, settings.dash_stale_max_s)

    @app.exception_handler(RequestValidationError)
    async def invalid_input(_request: Request, exc: RequestValidationError):
        # FastAPIs Standardantwort wiederholt die abgelehnte Eingabe ("input"). Bei einem Key wäre das ein Klartext-Geheimnis in der Antwort.
        errors = [{k: v for k, v in e.items() if k not in ("input", "ctx", "url")} for e in exc.errors()]
        return JSONResponse({"detail": errors}, status_code=422)

    app.state.registry = Registry(settings.hosts_file)
    app.state.ui = UiConfig(settings.ui_file)
    app.state.memory = MemoryRegistry(settings.memory_file)
    app.state.knowledge = KnowledgeRegistry(settings.knowledge_file)
    app.state.limiter = RateLimiter(settings.runs_per_minute)
    app.state.quota_gate = RefreshGate()
    app.state.login_limiter = RateLimiter(settings.logins_per_minute)
    app.state.sessions = SessionStore(settings.session_idle_s, settings.session_max_s)
    app.state.pending_logins = {}
    app.state.audit = AuditLog(settings.audit_file)
    app.state.souls = SoulHistory(settings.soul_dir)

    app.add_middleware(RedactionMiddleware)  # innerhalb von SecurityMiddleware: deren Header bleiben erhalten
    app.add_middleware(GZipMiddleware, minimum_size=1024)  # innerhalb der Sicherheits-Header, vor TrustedHost
    app.add_middleware(SecurityMiddleware, settings=settings)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.host_list())
    # Operations-Routen vor den dynamischen Agent-Routen: sonst schluckt /bff/h/{host}/{runtime}/{agent} die _hostd/_manage-Pfade.
    app.include_router(operations_routes.router)
    app.include_router(cli_auth.router)
    app.include_router(auth.router)
    app.include_router(hosts.router)
    app.include_router(agents.router)
    app.include_router(dashboard_routes.router)
    app.include_router(config_routes.router)
    app.include_router(tools_routes.router)
    app.include_router(messaging_routes.router)
    app.include_router(lifecycle_routes.router)
    app.include_router(models_routes.router)
    app.include_router(endpoints_routes.router)
    app.include_router(hermes_memory_routes.router)
    app.include_router(dashboard_routes.host_router)
    app.include_router(dashboard_routes.quota_router)
    app.include_router(memory_routes.router)
    app.include_router(knowledge_routes.router)
    app.include_router(rooms_routes.router)
    app.include_router(ui_routes.router)
    for extra in (kanban_routes, extensions_routes, marketplace_routes, composer_routes, cron_routes):
        app.include_router(extra.router)

    @app.get("/sw.js", include_in_schema=False)
    async def retire_service_worker():
        return Response(RETIRE_SERVICE_WORKER, media_type="text/javascript", headers={"Cache-Control": "no-cache"})

    @app.get("/healthz", include_in_schema=False)
    async def healthz():
        return {"ok": True}

    static = settings.static_dir
    if static and Path(static).is_dir():
        index = Path(static) / "index.html"
        app.mount("/assets", FingerprintedFiles(directory=Path(static) / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        async def spa(path: str):
            if path.startswith(("bff/", "auth/")):
                raise HTTPException(404)
            candidate = (Path(static) / path).resolve()
            if path and candidate.is_file() and Path(static).resolve() in candidate.parents:
                return FileResponse(candidate)
            return FileResponse(index, headers={"Cache-Control": "no-cache"})

    return app


def app_factory() -> FastAPI:
    return create_app()
