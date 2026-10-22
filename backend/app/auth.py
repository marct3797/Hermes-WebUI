"""Auth-Schicht. Alle /bff-Routen hängen an `current_user`.

Heute: Modus "none" (nur Entwicklung, Start in prod wird verweigert).
Vorgesehen: Modus "oidc" mit Forgejo als OAuth2/OIDC-Provider (Authorization Code + PKCE,
signierter Session-Cookie HttpOnly/Secure/SameSite=Strict). Dafür gibt es eine eigene Session;
sie ersetzt nur `current_user` und ergänzt /auth/login|callback|logout.
"""
from __future__ import annotations

from dataclasses import dataclass

from fastapi import HTTPException, Request

from .config import Settings


@dataclass(frozen=True)
class User:
    id: str
    name: str


def assert_auth_configured(settings: Settings) -> None:
    if settings.env == "prod" and settings.auth_mode == "none":
        raise RuntimeError("HERMES_WEBUI_ENV=prod verlangt HERMES_WEBUI_AUTH_MODE=oidc")
    if settings.auth_mode == "oidc":
        raise RuntimeError("Forgejo-OIDC ist noch nicht implementiert (eigene Session)")


async def current_user(request: Request) -> User:
    settings: Settings = request.app.state.settings
    if settings.auth_mode == "none":
        return User(id="dev", name="Entwicklung")
    raise HTTPException(401, "Nicht angemeldet")
