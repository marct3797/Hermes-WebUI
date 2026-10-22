"""OIDC-Client für Forgejo: Authorization Code mit PKCE (S256), state und nonce.

Das BFF ist der vertrauliche Client. Geprüft wird das ID-Token (Signatur über JWKS, iss, aud, exp,
nonce); danach entscheidet die Allowlist (`OIDC_ALLOWED_SUB`) in `routes/auth.py`.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import time
from typing import Any
from urllib.parse import urlencode, urlparse

import httpx
import jwt

from .config import Settings

# Nur asymmetrische Verfahren: HS* würde mit dem öffentlichen Schlüssel als Secret missbraucht (alg-Confusion).
ALLOWED_ALGS = {"RS256", "RS384", "RS512", "PS256", "ES256", "ES384", "EdDSA"}
CACHE_S = 3600
JWKS_REFETCH_MIN_S = 60


class OidcError(Exception):
    """Anmeldung nicht möglich. Die Meldung ist für Logs gedacht, nicht für den Browser."""


def pkce_pair(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


def _origin(url: str) -> tuple[str, str]:
    p = urlparse(url)
    return p.scheme, p.netloc


class OidcClient:
    def __init__(self, settings: Settings, http: httpx.AsyncClient):
        self.s, self._http = settings, http
        self._meta: dict[str, Any] | None = None
        self._meta_at = 0.0
        self._jwks: jwt.PyJWKSet | None = None
        self._jwks_at = 0.0

    @property
    def redirect_uri(self) -> str:
        return self.s.public_url.rstrip("/") + "/auth/callback"

    async def _get_json(self, url: str) -> dict[str, Any]:
        try:
            r = await self._http.get(url, headers={"Accept": "application/json"})
            r.raise_for_status()
            data = r.json()
        except (httpx.HTTPError, ValueError) as e:
            raise OidcError(f"Abruf fehlgeschlagen: {urlparse(url).path}") from e
        if not isinstance(data, dict):
            raise OidcError("Unerwartete Antwort")
        return data

    async def metadata(self) -> dict[str, Any]:
        if self._meta and time.monotonic() - self._meta_at < CACHE_S:
            return self._meta
        issuer = self.s.oidc_issuer.rstrip("/")
        meta = await self._get_json(f"{issuer}/.well-known/openid-configuration")
        if str(meta.get("issuer", "")).rstrip("/") != issuer:
            raise OidcError("Issuer in der Discovery passt nicht zur Konfiguration")
        for key in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
            # Alle Endpunkte müssen beim Issuer liegen: eine manipulierte Discovery darf nichts umlenken.
            if _origin(str(meta.get(key, ""))) != _origin(issuer):
                raise OidcError(f"{key} liegt nicht beim Issuer")
        self._meta, self._meta_at = meta, time.monotonic()
        return meta

    async def authorization_url(self, state: str, nonce: str, challenge: str, step_up: bool) -> str:
        meta = await self.metadata()
        params = {
            "response_type": "code", "client_id": self.s.oidc_client_id, "redirect_uri": self.redirect_uri,
            "scope": "openid profile", "state": state, "nonce": nonce,
            "code_challenge": challenge, "code_challenge_method": "S256",
        }
        if step_up:
            # Erzwingt eine neue Anmeldung, soweit der Anbieter es unterstützt (siehe SECURITY.md).
            params.update(prompt="login", max_age="0")
        return f"{meta['authorization_endpoint']}?{urlencode(params)}"

    async def exchange(self, code: str, verifier: str) -> dict[str, Any]:
        meta = await self.metadata()
        form = {
            "grant_type": "authorization_code", "code": code, "redirect_uri": self.redirect_uri,
            "code_verifier": verifier, "client_id": self.s.oidc_client_id,
        }
        secret = self.s.oidc_client_secret.get_secret_value()
        methods = meta.get("token_endpoint_auth_methods_supported") or ["client_secret_basic"]
        auth = None
        if "client_secret_basic" in methods:
            auth = httpx.BasicAuth(self.s.oidc_client_id, secret)
        else:
            form["client_secret"] = secret
        try:
            r = await self._http.post(meta["token_endpoint"], data=form, auth=auth, headers={"Accept": "application/json"})
            r.raise_for_status()
            tokens = r.json()
        except (httpx.HTTPError, ValueError) as e:
            raise OidcError("Token-Austausch fehlgeschlagen") from e
        if not isinstance(tokens, dict) or not isinstance(tokens.get("id_token"), str):
            raise OidcError("Antwort enthält kein id_token")
        return tokens

    async def _fetch_jwks(self, meta: dict[str, Any]) -> None:
        try:
            self._jwks = jwt.PyJWKSet.from_dict(await self._get_json(meta["jwks_uri"]))
        except jwt.PyJWTError as e:
            raise OidcError("JWKS ungültig") from e
        self._jwks_at = time.monotonic()

    def _find_key(self, kid: str | None) -> Any | None:
        keys = self._jwks.keys if self._jwks else []
        if kid is None and len(keys) == 1:
            return keys[0].key
        return next((k.key for k in keys if k.key_id == kid), None)

    async def _signing_key(self, kid: str | None) -> Any:
        meta = await self.metadata()
        if self._jwks is None or time.monotonic() - self._jwks_at > CACHE_S:
            await self._fetch_jwks(meta)
        key = self._find_key(kid)
        if key is None and time.monotonic() - self._jwks_at >= JWKS_REFETCH_MIN_S:
            await self._fetch_jwks(meta)  # Schlüsselrotation: höchstens einmal pro Minute nachladen
            key = self._find_key(kid)
        if key is None:
            raise OidcError("Signaturschlüssel unbekannt")
        return key

    async def verify_id_token(self, id_token: str, nonce: str) -> dict[str, Any]:
        meta = await self.metadata()
        try:
            header = jwt.get_unverified_header(id_token)
            alg = header.get("alg")
            if alg not in ALLOWED_ALGS:
                raise OidcError("Signaturverfahren nicht erlaubt")
            key = await self._signing_key(header.get("kid"))
            claims = jwt.decode(
                id_token, key, algorithms=[alg], audience=self.s.oidc_client_id,
                issuer=str(meta["issuer"]), leeway=30,
                options={"require": ["exp", "iat", "sub", "iss", "aud"]},
            )
        except jwt.PyJWTError as e:
            raise OidcError(f"ID-Token ungültig: {type(e).__name__}") from e
        if not hmac.compare_digest(str(claims.get("nonce", "")), nonce):
            raise OidcError("nonce stimmt nicht")
        return claims
