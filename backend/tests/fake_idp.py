"""Simulierter OIDC-Anbieter (Forgejo-Stil, ohne auth_time) für die Login-Tests."""
import base64
import hashlib
import secrets
import time
from urllib.parse import parse_qs, urlparse

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from jwt.algorithms import RSAAlgorithm

ISSUER = "https://idp.test"
CLIENT_ID = "cid"
CLIENT_SECRET = "csecret"


class FakeIdp:
    def __init__(self, now=None):
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.kid = "k1"
        self.sub = "42"
        self.codes: dict[str, dict] = {}
        self.claims: dict = {}  # überschreibt Claims im ID-Token
        self.sign_with = self.key
        self.alg = "RS256"
        self.discovery_overrides: dict = {}
        self.token_calls = 0
        # Zeitquelle für auth_time (Tests injizieren dieselbe Uhr wie SessionStore).
        # iat/exp bleiben Echtzeit, damit die Signaturprüfung nicht abläuft.
        self.now = now or time.time
        self.app = self._build()
        self.transport = httpx.ASGITransport(app=self.app)

    def _jwks(self) -> dict:
        jwk = RSAAlgorithm.to_jwk(self.key.public_key(), as_dict=True)
        return {"keys": [{**jwk, "kid": self.kid, "use": "sig", "alg": "RS256"}]}

    def authorize(self, location: str) -> str:
        """Spielt den Browser-Schritt nach: prüft die Anfrage und gibt einen Code aus."""
        q = {k: v[0] for k, v in parse_qs(urlparse(location).query).items()}
        assert urlparse(location).netloc == "idp.test"
        assert q["client_id"] == CLIENT_ID and q["response_type"] == "code" and q["scope"] == "openid profile"
        assert q["code_challenge_method"] == "S256" and q["redirect_uri"] == "https://testserver/auth/callback"
        code = secrets.token_urlsafe(8)
        self.codes[code] = {"nonce": q["nonce"], "challenge": q["code_challenge"]}
        return code

    def _build(self) -> FastAPI:
        app = FastAPI()

        @app.get("/.well-known/openid-configuration")
        async def discovery():
            # Forgejo/Gitea nennt den Issuer mit abschließendem Schrägstrich.
            return {
                "issuer": ISSUER + "/", "authorization_endpoint": f"{ISSUER}/login/oauth/authorize",
                "token_endpoint": f"{ISSUER}/login/oauth/access_token", "jwks_uri": f"{ISSUER}/login/oauth/keys",
                "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"],
                **self.discovery_overrides,
            }

        @app.get("/login/oauth/keys")
        async def keys():
            return self._jwks()

        @app.post("/login/oauth/access_token")
        async def token(request: Request):
            self.token_calls += 1
            form = {k: v[0] for k, v in parse_qs((await request.body()).decode()).items()}
            auth = request.headers.get("authorization", "")
            expected = "Basic " + base64.b64encode(f"{CLIENT_ID}:{CLIENT_SECRET}".encode()).decode()
            entry = self.codes.pop(form.get("code", ""), None)
            if auth != expected or entry is None or form.get("redirect_uri") != "https://testserver/auth/callback":
                return JSONResponse({"error": "invalid_grant"}, status_code=400)
            verifier_hash = base64.urlsafe_b64encode(hashlib.sha256(form["code_verifier"].encode()).digest()).rstrip(b"=").decode()
            if verifier_hash != entry["challenge"]:
                return JSONResponse({"error": "invalid_grant", "error_description": "PKCE"}, status_code=400)
            real_now = int(time.time())
            try:
                auth_default = int(self.now())
            except Exception:
                auth_default = real_now
            claims = {
                "iss": ISSUER + "/", "aud": CLIENT_ID, "sub": self.sub, "iat": real_now, "exp": real_now + 300,
                "nonce": entry["nonce"], "preferred_username": "alex", "auth_time": auth_default, **self.claims,
            }
            claims = {k: v for k, v in claims.items() if v is not None}
            key = self.sign_with if self.alg.startswith(("RS", "PS")) else "geheim-geheim-geheim-geheim-geheim"
            id_token = jwt.encode(claims, key, algorithm=self.alg, headers={"kid": self.kid})
            return {"access_token": "at", "token_type": "Bearer", "id_token": id_token}

        return app
