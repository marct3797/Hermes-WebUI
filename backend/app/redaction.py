"""Hermes liefert Keys als «redacted:abcd...wxyz» (Anfang und Ende). Die WebUI zeigt nie Fragmente."""
from __future__ import annotations

import re

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

# Rohtext statt JSON-Baum: trifft jede Stelle in jeder Tiefe, auch mit \u00ab-Escapes.
FRAGMENT = re.compile(r"(?:«|\\u00ab)redacted:[^»\\]*(?:»|\\u00bb)", re.IGNORECASE)


def redact_fragments(text: str) -> str:
    return FRAGMENT.sub("«redacted»", text)


class RedactionMiddleware(BaseHTTPMiddleware):
    """Kürzt Key-Fragmente in allen JSON-Antworten unter /bff/h/. Streams (SSE) und Downloads bleiben unberührt."""

    async def dispatch(self, request, call_next):
        response = await call_next(request)
        if not request.url.path.startswith("/bff/h/") or not response.headers.get("content-type", "").startswith("application/json"):
            return response
        body = b"".join([chunk async for chunk in response.body_iterator])
        result = Response(redact_fragments(body.decode("utf-8", "replace")).encode(), status_code=response.status_code)
        result.raw_headers = [(k, v) for k, v in response.raw_headers if k != b"content-length"] + result.raw_headers[:1]
        return result
