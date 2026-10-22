from __future__ import annotations

import time
from collections import defaultdict, deque
from urllib.parse import urlparse

from fastapi import HTTPException, Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from .config import Settings

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

# Das UI lädt alles von sich selbst. Bilder als data:/blob: für Anhänge und Markdown-Bilder.
CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; "
    "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; "
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
)


class SecurityMiddleware(BaseHTTPMiddleware):
    """Header-Härtung, Body-Limit und CSRF-Schutz (Origin-Prüfung bei schreibenden Aufrufen)."""

    def __init__(self, app, settings: Settings):
        super().__init__(app)
        self.s = settings

    async def dispatch(self, request: Request, call_next):
        if request.method not in SAFE_METHODS:
            length = request.headers.get("content-length")
            if length and length.isdigit() and int(length) > self.s.max_body_bytes:
                return JSONResponse({"detail": "Anfrage zu groß"}, status_code=413)
            origin = request.headers.get("origin")
            if origin and urlparse(origin).netloc != request.headers.get("host"):
                return JSONResponse({"detail": "Origin nicht erlaubt"}, status_code=403)
            if request.headers.get("x-requested-with") != "hermes-webui":
                return JSONResponse({"detail": "CSRF-Header fehlt"}, status_code=403)

        response = await call_next(request)
        h = response.headers
        h["Content-Security-Policy"] = CSP
        h["X-Content-Type-Options"] = "nosniff"
        h["X-Frame-Options"] = "DENY"
        h["Referrer-Policy"] = "no-referrer"
        h["Permissions-Policy"] = "camera=(), geolocation=(), microphone=(self)"
        h["Cross-Origin-Opener-Policy"] = "same-origin"
        h["Cross-Origin-Resource-Policy"] = "same-origin"
        if self.s.env == "prod":
            h["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
        if request.url.path.startswith("/bff/"):
            h["Cache-Control"] = "no-store"
        return response


class RateLimiter:
    """Einfaches Fenster pro Client. Reicht für einen Einzelnutzer-BFF; bei Mehrnutzer ersetzen."""

    def __init__(self, per_minute: int):
        self.per_minute = per_minute
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def check(self, key: str) -> None:
        now = time.monotonic()
        q = self._hits[key]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= self.per_minute:
            raise HTTPException(429, "Zu viele Anfragen, bitte kurz warten")
        q.append(now)
