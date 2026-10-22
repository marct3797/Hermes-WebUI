"""Auth-Schicht. Alle /bff-Routen hängen an `current_user`.

Modus "none": nur Entwicklung, Start in prod wird verweigert.
Modus "oidc": Forgejo als OAuth2/OIDC-Anbieter (Ablauf in `oidc.py`, Routen in `routes/auth.py`).
Das BFF hält die Sitzung serverseitig; der Browser bekommt nur eine zufällige Sitzungs-ID im Cookie
(`__Host-`, HttpOnly, Secure, SameSite=Strict). Tokens des Anbieters gelangen nie in den Browser.
"""
from __future__ import annotations

import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from urllib.parse import urlparse

from fastapi import Depends, HTTPException, Request

from .config import Settings

SESSION_COOKIE = "__Host-hermes_session"
LOGIN_COOKIE = "__Host-hermes_login"  # bindet einen Anmeldeversuch an den Browser (SameSite=Lax: kommt vom Anbieter zurück)


@dataclass(frozen=True)
class User:
    id: str
    name: str


DEV_USER = User(id="dev", name="Entwicklung")


@dataclass
class Session:
    id: str
    user: User
    created: float
    last_seen: float
    auth_time: float  # letzte echte Anmeldung; Grundlage des Step-up


class SessionStore:
    """Sitzungen im Speicher. Ein Neustart des BFF meldet ab, die Anmeldung über Forgejo ist schnell."""

    def __init__(self, idle_s: int, max_s: int, clock: Callable[[], float] = time.time):
        self.idle_s, self.max_s, self._clock = idle_s, max_s, clock
        self._sessions: dict[str, Session] = {}

    def now(self) -> float:
        return self._clock()

    def create(self, user: User) -> Session:
        now = self._clock()
        sess = Session(secrets.token_urlsafe(32), user, now, now, now)
        self._sessions[sess.id] = sess
        self.purge()
        return sess

    def get(self, sid: str | None) -> Session | None:
        sess = self._sessions.get(sid or "")
        if sess is None:
            return None
        now = self._clock()
        if now - sess.last_seen > self.idle_s or now - sess.created > self.max_s:
            del self._sessions[sess.id]
            return None
        sess.last_seen = now
        return sess

    def delete(self, sid: str | None) -> Session | None:
        return self._sessions.pop(sid or "", None)

    def purge(self) -> None:
        now = self._clock()
        for sid, s in list(self._sessions.items()):
            if now - s.last_seen > self.idle_s or now - s.created > self.max_s:
                del self._sessions[sid]


def assert_auth_configured(settings: Settings) -> None:
    if settings.env == "prod" and settings.auth_mode == "none":
        raise RuntimeError("HERMES_WEBUI_ENV=prod verlangt HERMES_WEBUI_AUTH_MODE=oidc")
    if settings.auth_mode == "oidc":
        missing = [
            name for name, ok in {
                "FORGEJO_ISSUER": settings.oidc_issuer,
                "FORGEJO_OIDC_CLIENT_ID": settings.oidc_client_id,
                "FORGEJO_OIDC_CLIENT_SECRET": settings.oidc_client_secret.get_secret_value(),
                "OIDC_ALLOWED_SUB": settings.allowed_subs(),
                "HERMES_WEBUI_PUBLIC_URL": settings.public_url,
            }.items() if not ok
        ]
        if missing:
            raise RuntimeError("OIDC unvollständig konfiguriert: " + ", ".join(missing))
        if settings.env == "prod":
            for name, url in (("FORGEJO_ISSUER", settings.oidc_issuer), ("HERMES_WEBUI_PUBLIC_URL", settings.public_url)):
                if urlparse(url).scheme != "https":
                    raise RuntimeError(f"{name} muss in prod https verwenden")
    if settings.env == "prod" and "*" in settings.host_list():
        raise RuntimeError("HERMES_WEBUI_ALLOWED_HOSTS darf in prod kein * enthalten")


def session_of(request: Request) -> Session | None:
    return request.app.state.sessions.get(request.cookies.get(SESSION_COOKIE))


async def current_user(request: Request) -> User:
    settings: Settings = request.app.state.settings
    if settings.auth_mode == "none":
        return DEV_USER
    sess = session_of(request)
    if sess is None:
        raise HTTPException(401, "Nicht angemeldet")
    return sess.user


async def fresh_user(request: Request, user: User = Depends(current_user)) -> User:
    """Step-up: riskante Aktionen verlangen eine Anmeldung, die höchstens `step_up_s` alt ist."""
    settings: Settings = request.app.state.settings
    if settings.auth_mode == "none":
        return user
    sess = session_of(request)
    if sess is None or request.app.state.sessions.now() - sess.auth_time > settings.step_up_s:
        raise HTTPException(401, {"code": "step_up_required", "message": "Bitte erneut anmelden"})
    return user


def is_fresh(request: Request) -> bool:
    settings: Settings = request.app.state.settings
    if settings.auth_mode == "none":
        return True
    sess = session_of(request)
    return sess is not None and request.app.state.sessions.now() - sess.auth_time <= settings.step_up_s
