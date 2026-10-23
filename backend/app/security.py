from __future__ import annotations

import time
from collections import defaultdict, deque
from urllib.parse import urlparse

from fastapi import HTTPException, Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from .config import Settings

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

# Das UI lädt alles von sich selbst (Schriften und Skripte werden mitgebaut, kein CDN).
# Bilder als data:/blob: für Anhänge und Markdown-Bilder.
CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; "
    "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; "
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
)


def client_ip(request: Request, settings: Settings) -> str | None:
    """Adresse des Clients. X-Forwarded-For zählt nur, wenn die Verbindung vom vertrauten Proxy kommt."""
    peer = request.client.host if request.client else None
    fwd = request.headers.get("x-forwarded-for")
    if peer and fwd and peer in settings.proxy_list():
        return fwd.split(",")[-1].strip() or peer  # letzter Eintrag: den hat unser Proxy angehängt
    return peer


class SecurityMiddleware(BaseHTTPMiddleware):
    """Header-Härtung, Body-Limit und CSRF-Schutz (Origin-Prüfung bei schreibenden Aufrufen)."""

    def __init__(self, app, settings: Settings):
        super().__init__(app)
        self.s = settings

    async def dispatch(self, request: Request, call_next):
        response = None
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > self.s.max_body_bytes:
            response = JSONResponse({"detail": "Anfrage zu groß"}, status_code=413)
        elif request.method not in SAFE_METHODS:
            origin = request.headers.get("origin")
            if origin and urlparse(origin).netloc != request.headers.get("host"):
                response = JSONResponse({"detail": "Origin nicht erlaubt"}, status_code=403)
            elif request.headers.get("x-requested-with") != "hermes-webui":
                response = JSONResponse({"detail": "CSRF-Header fehlt"}, status_code=403)

        if response is None:
            chunks, size = [], 0
            async for chunk in request.stream():
                size += len(chunk)
                if size > self.s.max_body_bytes:
                    response = JSONResponse({"detail": "Anfrage zu groß"}, status_code=413)
                    break
                chunks.append(chunk)
            if response is None:
                # BaseHTTPMiddleware replays the bounded cached body to downstream consumers.
                request._body = b"".join(chunks)
                response = await call_next(request)
        h = response.headers
        if "content-security-policy" not in h:  # Routen dürfen strenger sein (z. B. SVG-Bilder)
            h["Content-Security-Policy"] = CSP
        h["X-Content-Type-Options"] = "nosniff"
        h["X-Frame-Options"] = "DENY"
        h["Referrer-Policy"] = "no-referrer"
        h["Permissions-Policy"] = "camera=(), geolocation=(), microphone=(self)"
        h["Cross-Origin-Opener-Policy"] = "same-origin"
        h["Cross-Origin-Resource-Policy"] = "same-origin"
        if self.s.env == "prod":
            h["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
        if request.url.path.startswith(("/bff/", "/auth/")):
            h["Cache-Control"] = "no-store"
        return response


class RateLimiter:
    """Einfaches Fenster pro Schlüssel. Reicht für einen Einzelnutzer-BFF; bei Mehrnutzer ersetzen."""

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
