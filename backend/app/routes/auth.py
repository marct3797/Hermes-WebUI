"""Login über den OIDC-Anbieter (Authorization Code + PKCE) und Logout."""
from __future__ import annotations

import hmac
import secrets
import time
from dataclasses import dataclass

from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.responses import RedirectResponse

from ..auth import LOGIN_COOKIE, SESSION_COOKIE, User, session_of
from ..oidc import OidcClient, OidcError, authentication_time, pkce_pair, step_up_proof
from ..security import client_ip

router = APIRouter(prefix="/auth")
PENDING_TTL_S = 600
PENDING_MAX = 200


@dataclass
class Pending:
    nonce: str
    verifier: str
    browser: str
    next_path: str
    created: float
    step_up: bool
    requested_at: float


def safe_next(value: str) -> str:
    """Nur Pfade dieser Seite: kein Schema, kein Host, kein Backslash-Trick."""
    if not value.startswith("/") or value.startswith("//") or "\\" in value or any(c < " " for c in value):
        return "/"
    return value


def _pending(request: Request) -> dict[str, Pending]:
    store = request.app.state.pending_logins
    now = time.monotonic()
    for k in [k for k, p in store.items() if now - p.created > PENDING_TTL_S]:
        del store[k]
    return store


def _cookie(response: Response, name: str, value: str, max_age: int, samesite: str) -> None:
    response.set_cookie(name, value, max_age=max_age, path="/", secure=True, httponly=True, samesite=samesite)


@router.get("/login")
async def login(request: Request, next: str = "/", step_up: bool = False):
    settings = request.app.state.settings
    if settings.auth_mode == "none":
        return RedirectResponse(safe_next(next), status_code=302)
    ip = client_ip(request, settings) or "unbekannt"
    request.app.state.login_limiter.check(ip)
    store = _pending(request)
    if len(store) >= PENDING_MAX:
        raise HTTPException(429, "Zu viele offene Anmeldungen")

    oidc: OidcClient = request.app.state.oidc
    state, nonce, verifier, browser = (secrets.token_urlsafe(n) for n in (32, 32, 64, 32))
    try:
        url = await oidc.authorization_url(state, nonce, pkce_pair(verifier), step_up)
    except OidcError as e:
        request.app.state.audit.record("login.start", ip=ip, outcome="error", reason=str(e))
        raise HTTPException(502, "Der Anmeldedienst ist nicht erreichbar") from e
    store[state] = Pending(nonce, verifier, browser, safe_next(next), time.monotonic(), step_up, request.app.state.sessions.now())
    response = RedirectResponse(url, status_code=302)
    # Lax, weil der Browser vom Anbieter (anderer Site) zurückkehrt; Strict würde das Cookie nicht mitschicken.
    _cookie(response, LOGIN_COOKIE, browser, PENDING_TTL_S, "lax")
    return response


@router.get("/callback")
async def callback(
    request: Request, code: str | None = Query(None, max_length=2048), state: str | None = Query(None, max_length=256),
    error: str | None = Query(None, max_length=200),
):
    app = request.app
    settings, audit = app.state.settings, app.state.audit
    ip = client_ip(request, settings)
    if settings.auth_mode == "none":
        raise HTTPException(404)

    def fail(reason: str, status: int = 400, detail: str = "Anmeldung ungültig oder abgelaufen", consumed: bool = True):
        audit.record("login", ip=ip, outcome="denied", reason=reason)
        response = Response(status_code=status, content=detail, media_type="text/plain; charset=utf-8")
        if consumed:  # Ein erfundener state darf den laufenden Anmeldeversuch eines Browsers nicht abräumen.
            response.delete_cookie(LOGIN_COOKIE, path="/", secure=True, httponly=True, samesite="lax")
        return response

    pending = _pending(request).pop(state or "", None)  # einmalig: ein zweiter Versuch mit demselben state scheitert
    if pending is None:
        return fail("state", consumed=False)
    if error or not code:
        return fail("idp_error")
    if not hmac.compare_digest(request.cookies.get(LOGIN_COOKIE, ""), pending.browser):
        return fail("browser_mismatch")

    oidc: OidcClient = app.state.oidc
    try:
        tokens = await oidc.exchange(code, pending.verifier)
        claims = await oidc.verify_id_token(tokens["id_token"], pending.nonce)
    except OidcError as e:
        return fail(str(e), 502, "Anmeldung fehlgeschlagen")

    sub = str(claims["sub"])
    if sub not in settings.allowed_subs():
        audit.record("login", user=sub, ip=ip, outcome="denied", reason="not_allowed")
        response = Response(status_code=403, content="Dieses Konto ist nicht zugelassen", media_type="text/plain; charset=utf-8")
        response.delete_cookie(LOGIN_COOKIE, path="/", secure=True, httponly=True, samesite="lax")
        return response

    sessions = app.state.sessions
    auth_time = authentication_time(claims, sessions.now())
    # NumericDate has whole-second precision; do not turn callback arrival into authentication.
    if pending.step_up and (auth_time is None or auth_time < int(pending.requested_at) or sessions.now() - auth_time > settings.step_up_s):
        # Manche Anbieter (z. B. Forgejo) werben claims_supported ohne auth_time an. Dann belegt der frische
        # Step-up-Roundtrip mit prompt=login die erneute Anmeldung, statt das System unbedienbar zu machen.
        # Unbekannte IdP-Fähigkeit bleibt fail-closed; normales SSO wird nie frisch gemacht.
        fallback_ok = False
        if auth_time is None:
            try:
                meta = await oidc.metadata()
                now = sessions.now()
                if step_up_proof(meta) == "prompt_login_only" and 0 <= now - pending.requested_at <= settings.step_up_s:
                    auth_time = now
                    fallback_ok = True
            except OidcError:
                fallback_ok = False
        if not fallback_ok:
            return fail("authentication_not_fresh", 401, "Erneute Anmeldung nicht belegt")
    sessions.delete(request.cookies.get(SESSION_COOKIE))  # Rotation: nie eine alte Sitzungs-ID weiterverwenden
    name = str(claims.get("preferred_username") or claims.get("name") or sub)
    sess = sessions.create(User(id=sub, name=name), auth_time=auth_time)
    audit.record("login", user=sub, ip=ip)
    response = RedirectResponse(pending.next_path, status_code=303)
    _cookie(response, SESSION_COOKIE, sess.id, settings.session_max_s, "strict")
    response.delete_cookie(LOGIN_COOKIE, path="/", secure=True, httponly=True, samesite="lax")
    return response


@router.post("/logout", status_code=204)
async def logout(request: Request):
    sess = session_of(request)
    if sess:
        request.app.state.sessions.delete(sess.id)
        request.app.state.audit.record("logout", user=sess.user.id, ip=client_ip(request, request.app.state.settings))
    response = Response(status_code=204)
    response.delete_cookie(SESSION_COOKIE, path="/", secure=True, httponly=True, samesite="strict")
    return response
