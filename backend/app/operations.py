"""Bounded hostd transport and reviewed discovery sources. No browser credentials upstream."""
from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import HTTPException

from .registry import HostdCfg

JSON_LIMIT = 2 * 1024 * 1024
DOWNLOAD_LIMIT = 16 * 1024 * 1024
UPLOAD_LIMIT = 1024 * 1024

# Source existence verified against official pages; a source is not an endorsement of every package.
REVIEWED_SOURCES = [
    {"id": "hermes", "label": "Hermes Agent", "url": "https://github.com/NousResearch/hermes-agent",
     "kinds": ["skills", "plugins"], "installable": False,
     "trust": "Native Hermes source/docs; inspect code and pin revision before host-side installation."},
    {"id": "mcp-registry", "label": "Official MCP Registry", "url": "https://registry.modelcontextprotocol.io",
     "kinds": ["mcp"], "installable": False,
     "trust": "Discovery only, registry entries are not a security audit; review permissions and provenance."},
    {"id": "mcp-reference", "label": "MCP reference servers", "url": "https://github.com/modelcontextprotocol/servers",
     "kinds": ["mcp"], "installable": False,
     "trust": "Review and pin individual servers; no arbitrary URL installation via the BFF."},
]


def safe_data(value: Any, token: str) -> Any:
    """Never echo our credential even if a broken daemon reflects its request headers."""
    if isinstance(value, str):
        return value.replace(token, "[redacted]") if token else value
    if isinstance(value, list):
        return [safe_data(v, token) for v in value]
    if isinstance(value, dict):
        return {safe_data(k, token): safe_data(v, token) for k, v in value.items()}
    return value


class HostdClient:
    def __init__(self, cfg: HostdCfg, http: httpx.AsyncClient):
        self.cfg, self.http = cfg, http

    async def request(self, method: str, path: str, *, params=None, body=None, download=False, messages=None) -> Any:
        limit = DOWNLOAD_LIMIT if download else JSON_LIMIT
        try:
            async with self.http.stream(method, self.cfg.base_url + path,
                    headers={"Authorization": f"Bearer {self.cfg.token}", "Accept": "application/octet-stream" if download else "application/json"},
                    params=params, json=body, follow_redirects=False) as response:
                if not 200 <= response.status_code < 300:
                    status = response.status_code
                    if messages and status in messages:  # Dateifehler des Host-Dienstes verständlich durchreichen (auch 403)
                        raise HTTPException(status, messages[status])
                    raise HTTPException(502 if status in (401, 403) or status < 400 else status,
                                        f"Host-Dienst antwortet mit HTTP {status}")
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > limit:
                        raise HTTPException(502, "Antwort des Host-Dienstes zu groß")
                if download:
                    return bytes(data)
                if not data:
                    return {}
                try:
                    result = json.loads(data)
                except (ValueError, UnicodeError):
                    raise HTTPException(502, "Ungültige JSON-Antwort des Host-Dienstes") from None
                if not isinstance(result, dict):
                    raise HTTPException(502, "Ungültige Antwort des Host-Dienstes")
                return safe_data(result, self.cfg.token)
        except httpx.TimeoutException:
            raise HTTPException(504, "Host-Dienst antwortet nicht rechtzeitig") from None
        except httpx.HTTPError:
            raise HTTPException(502, "Host-Dienst nicht erreichbar") from None


def websocket_connect(cfg: HostdCfg, terminal_id: str, after: int):
    # uvicorn[standard] already supplies websockets. No redirects/proxy env or browser headers.
    from websockets.asyncio.client import connect
    u = urlsplit(cfg.base_url)
    url = urlunsplit(("wss" if u.scheme == "https" else "ws", u.netloc,
                     f"/v1/terminals/{terminal_id}/stream", f"after={after}", ""))
    return connect(url, additional_headers={"Authorization": f"Bearer {cfg.token}"},
                   max_size=512 * 1024, max_queue=8, open_timeout=10, proxy=None)
