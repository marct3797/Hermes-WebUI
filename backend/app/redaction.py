"""Hermes liefert Keys als «redacted:abcd...wxyz» (Anfang und Ende). Die WebUI zeigt nie Fragmente."""
from __future__ import annotations

import re

# Rohtext statt JSON-Baum: trifft jede Stelle in jeder Tiefe, auch mit \u00ab-Escapes.
FRAGMENT = re.compile(r"(?:«|\\u00ab)redacted:[^»\\]*(?:»|\\u00bb)", re.IGNORECASE)


def redact_fragments(text: str) -> str:
    return FRAGMENT.sub("«redacted»", text)


class RedactionMiddleware:
    """Kürzt Key-Fragmente in allen JSON-Antworten unter /bff/h/. Streams (SSE) und Downloads bleiben unberührt.

    Reine ASGI-Middleware (kein BaseHTTPMiddleware): Antworten bleiben einteilig, damit GZip die Mindestgröße prüfen kann.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/bff/h/"):
            return await self.app(scope, receive, send)
        start: dict | None = None
        chunks: list[bytes] = []
        active = False  # JSON-Antwort, die gepuffert wird

        async def wrapped(message):
            nonlocal start, active
            if message["type"] == "http.response.start":
                headers = {k.lower(): v for k, v in message.get("headers", [])}
                active = headers.get(b"content-type", b"").startswith(b"application/json")
                if not active:
                    return await send(message)
                start = message
                return None
            if not active:
                return await send(message)
            chunks.append(message.get("body", b""))
            if message.get("more_body"):
                return None
            body = redact_fragments(b"".join(chunks).decode("utf-8", "replace")).encode()
            headers = [(k, v) for k, v in start["headers"] if k.lower() != b"content-length"] + [(b"content-length", str(len(body)).encode())]
            await send({**start, "headers": headers})
            await send({"type": "http.response.body", "body": body})
            return None

        await self.app(scope, receive, wrapped)
