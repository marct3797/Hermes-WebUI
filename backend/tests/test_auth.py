import json
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import SESSION_COOKIE, SessionStore, User
from app.config import Settings
from app.main import create_app
from app.routes.auth import safe_next
from devtools.mock_hermes import create_mock
from tests.conftest import BASE, HDR, RouterTransport
from tests.fake_idp import CLIENT_ID, CLIENT_SECRET, ISSUER, FakeIdp


class Clock:
    def __init__(self):
        self.t = 1_000_000.0

    def __call__(self):
        return self.t


@pytest.fixture
def idp():
    return FakeIdp()


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def oidc_app(make_settings, idp, clock):
    settings = make_settings(
        auth_mode="oidc", oidc_issuer=ISSUER, oidc_client_id=CLIENT_ID, oidc_client_secret=CLIENT_SECRET,
        oidc_allowed_sub="42", public_url="https://testserver", step_up_s=600,
    )
    mock = create_mock(wait_for_user=False, delay=0)
    app = create_app(
        settings, transport=RouterTransport({"hermes.test": httpx.ASGITransport(app=mock)}),
        oidc_transport=RouterTransport({"idp.test": idp.transport}),
    )
    app.state.sessions = SessionStore(settings.session_idle_s, settings.session_max_s, clock=clock)
    return app


@pytest.fixture
def web(oidc_app):
    with TestClient(oidc_app, base_url="https://testserver") as c:
        c.headers.update(HDR)
        yield c


def start_login(web, **params):
    r = web.get("/auth/login", params=params, follow_redirects=False)
    assert r.status_code == 302, r.text
    return r.headers["location"]


def do_login(web, idp, **params):
    location = start_login(web, **params)
    code = idp.authorize(location)
    state = parse_qs(urlparse(location).query)["state"][0]
    return web.get("/auth/callback", params={"code": code, "state": state}, follow_redirects=False)


# --- Anmeldung ---------------------------------------------------------------------------------
def test_api_requires_login(web):
    assert web.get("/bff/hosts").status_code == 401
    assert web.get("/bff/me").status_code == 401
    assert web.get(f"{BASE}/sessions").status_code == 401
    assert web.get("/healthz").status_code == 200


def test_full_login_flow_and_cookie_flags(web, idp):
    r = do_login(web, idp)
    assert r.status_code == 303 and r.headers["location"] == "/"
    cookie = next(c for c in r.headers.get_list("set-cookie") if c.startswith(SESSION_COOKIE))
    low = cookie.lower()
    assert "httponly" in low and "secure" in low and "samesite=strict" in low and "path=/" in low and "domain" not in low
    me = web.get("/bff/me").json()
    assert me["user"] == {"id": "42", "name": "marc"} and me["auth_mode"] == "oidc" and me["fresh"] is True
    assert web.get("/bff/hosts").status_code == 200


def test_pkce_and_state_are_sent(web):
    q = parse_qs(urlparse(start_login(web)).query)
    assert q["code_challenge_method"] == ["S256"] and len(q["state"][0]) >= 32 and len(q["nonce"][0]) >= 32
    assert "prompt" not in q
    q2 = parse_qs(urlparse(start_login(web, step_up="true")).query)
    assert q2["prompt"] == ["login"] and q2["max_age"] == ["0"]


def test_login_cookie_is_lax_and_session_cookie_absent_before_login(web):
    r = web.get("/auth/login", follow_redirects=False)
    login_cookie = next(c for c in r.headers.get_list("set-cookie") if c.startswith("__Host-hermes_login")).lower()
    assert "samesite=lax" in login_cookie and "httponly" in login_cookie and "secure" in login_cookie
    assert SESSION_COOKIE not in "".join(r.headers.get_list("set-cookie"))


def test_account_not_on_allowlist_is_rejected(web, idp):
    idp.sub = "666"
    r = do_login(web, idp)
    assert r.status_code == 403 and SESSION_COOKIE not in "".join(r.headers.get_list("set-cookie"))
    assert web.get("/bff/me").status_code == 401


def test_state_is_single_use_and_must_be_known(web, idp):
    location = start_login(web)
    code = idp.authorize(location)
    state = parse_qs(urlparse(location).query)["state"][0]
    assert web.get("/auth/callback", params={"code": code, "state": "falsch"}, follow_redirects=False).status_code == 400
    assert web.get("/auth/callback", params={"code": code, "state": state}, follow_redirects=False).status_code == 303
    assert web.get("/auth/callback", params={"code": code, "state": state}, follow_redirects=False).status_code == 400


def test_callback_without_login_cookie_is_rejected(web, idp, oidc_app):
    location = start_login(web)
    code = idp.authorize(location)
    state = parse_qs(urlparse(location).query)["state"][0]
    with TestClient(oidc_app, base_url="https://testserver") as other:  # anderer Browser, gleicher state
        r = other.get("/auth/callback", params={"code": code, "state": state}, follow_redirects=False)
    assert r.status_code == 400


def test_idp_error_and_missing_code(web):
    assert web.get("/auth/callback", params={"error": "access_denied"}, follow_redirects=False).status_code == 400
    assert web.get("/auth/callback", follow_redirects=False).status_code == 400


@pytest.mark.parametrize("claims,alg", [
    ({"nonce": "anders"}, "RS256"),
    ({"aud": "fremd"}, "RS256"),
    ({"iss": "https://evil.test/"}, "RS256"),
    ({"exp": 1}, "RS256"),
    ({"sub": None}, "RS256"),
    ({}, "HS256"),  # alg-Confusion: symmetrisch signiert
])
def test_bad_id_tokens_are_rejected(web, idp, claims, alg):
    idp.claims, idp.alg = claims, alg
    r = do_login(web, idp)
    assert r.status_code == 502 and web.get("/bff/me").status_code == 401


def test_token_signed_with_foreign_key_is_rejected(web, idp):
    idp.sign_with = idp.other_key
    assert do_login(web, idp).status_code == 502


def test_discovery_cannot_redirect_to_other_hosts(web, idp):
    idp.discovery_overrides = {"authorization_endpoint": "https://evil.test/authorize"}
    r = web.get("/auth/login", follow_redirects=False)
    assert r.status_code == 502


def test_wrong_client_secret_fails(web, idp, make_settings):
    web.app.state.oidc.s = make_settings(
        auth_mode="oidc", oidc_issuer=ISSUER, oidc_client_id=CLIENT_ID, oidc_client_secret="falsch",
        oidc_allowed_sub="42", public_url="https://testserver")
    assert do_login(web, idp).status_code == 502


@pytest.mark.parametrize("value,expected", [
    ("/h/hikari/hermes/default/chat/x?y=1", "/h/hikari/hermes/default/chat/x?y=1"),
    ("//evil.example", "/"), ("https://evil.example", "/"), ("/\\evil.example", "/"), ("evil", "/"), ("/a\nb", "/"),
])
def test_next_parameter_is_sanitized(value, expected):
    assert safe_next(value) == expected


def test_next_is_followed_after_login(web, idp):
    r = do_login(web, idp, next="/inbox")
    assert r.headers["location"] == "/inbox"
    web.cookies.clear()
    assert do_login(web, idp, next="//evil.example").headers["location"] == "/"


def test_login_rate_limit(web):
    web.app.state.login_limiter.per_minute = 2
    codes = [web.get("/auth/login", follow_redirects=False).status_code for _ in range(3)]
    assert codes == [302, 302, 429]


# --- Logout, Ablauf, Step-up -----------------------------------------------------------------------
def test_logout_revokes_session(web, idp):
    do_login(web, idp)
    stolen = web.cookies.get(SESSION_COOKIE)
    assert web.post("/auth/logout").status_code == 204
    assert web.get("/bff/me").status_code == 401
    web.cookies.set(SESSION_COOKIE, stolen)  # das alte Cookie ist serverseitig ungültig
    assert web.get("/bff/me").status_code == 401


def test_logout_needs_csrf_header(web, idp):
    do_login(web, idp)
    assert web.post("/auth/logout", headers={"X-Requested-With": ""}).status_code == 403
    assert web.get("/bff/me").status_code == 200


def test_new_login_rotates_session_id(web, idp):
    do_login(web, idp)
    first = web.cookies.get(SESSION_COOKIE)
    do_login(web, idp)
    assert web.cookies.get(SESSION_COOKIE) != first


def test_session_expires_when_idle_and_at_max_age(web, idp, clock):
    do_login(web, idp)
    clock.t += 11 * 3600
    assert web.get("/bff/me").status_code == 200  # innerhalb der Leerlaufzeit (12 h), Zeitstempel wird erneuert
    clock.t += 13 * 3600
    assert web.get("/bff/me").status_code == 401
    do_login(web, idp)
    for _ in range(16):  # aktiv bleiben, aber die Höchstdauer (7 Tage) überschreiten
        clock.t += 11 * 3600
        web.get("/bff/me")
    assert web.get("/bff/me").status_code == 401


def test_always_approval_requires_fresh_login(web, idp, clock):
    do_login(web, idp)
    clock.t += 3600  # Sitzung lebt, Anmeldung ist aber älter als 10 Minuten
    assert web.get("/bff/me").json()["fresh"] is False
    info = web.post(f"{BASE}/runs", json={"text": "hallo"}).json()
    r = web.post(f"{BASE}/runs/{info['run_id']}/approval", json={"decision": "always"})
    assert r.status_code == 401 and r.json()["detail"]["code"] == "step_up_required"
    # einmalig erlauben bleibt ohne Step-up möglich (Upstream meldet hier 409: nichts offen)
    assert web.post(f"{BASE}/runs/{info['run_id']}/approval", json={"decision": "once"}).status_code == 409
    do_login(web, idp, step_up="true")
    assert web.get("/bff/me").json()["fresh"] is True
    assert web.post(f"{BASE}/runs/{info['run_id']}/approval", json={"decision": "always"}).status_code == 409


def test_session_store_unit():
    clock = Clock()
    store = SessionStore(idle_s=10, max_s=100, clock=clock)
    s = store.create(User("1", "a"))
    assert store.get(s.id) is s and store.get(None) is None and store.get("nope") is None
    clock.t += 11
    assert store.get(s.id) is None
    s2 = store.create(User("1", "a"))
    for _ in range(12):
        clock.t += 9
        store.get(s2.id)
    assert store.get(s2.id) is None  # Höchstdauer


# --- Konfiguration -------------------------------------------------------------------------------
def test_env_names_from_architecture_are_read(monkeypatch):
    for k, v in {"FORGEJO_ISSUER": "https://git.thiel.digital", "FORGEJO_OIDC_CLIENT_ID": "abc",
                 "FORGEJO_OIDC_CLIENT_SECRET": "s3", "OIDC_ALLOWED_SUB": "1, 2"}.items():
        monkeypatch.setenv(k, v)
    s = Settings(_env_file=None)
    assert s.oidc_issuer == "https://git.thiel.digital" and s.oidc_client_id == "abc"
    assert s.oidc_client_secret.get_secret_value() == "s3" and s.allowed_subs() == {"1", "2"}
    assert "s3" not in repr(s)


def test_prod_requires_complete_oidc(make_settings):
    with pytest.raises(RuntimeError, match="prod"):
        create_app(make_settings(env="prod", auth_mode="none"))
    with pytest.raises(RuntimeError, match="OIDC_ALLOWED_SUB"):
        create_app(make_settings(env="prod", auth_mode="oidc", oidc_issuer=ISSUER, oidc_client_id="a",
                                 oidc_client_secret="b", public_url="https://x.test"))
    with pytest.raises(RuntimeError, match="https"):
        create_app(make_settings(env="prod", auth_mode="oidc", oidc_issuer="http://git.test", oidc_client_id="a",
                                 oidc_client_secret="b", oidc_allowed_sub="1", public_url="https://x.test"))
    with pytest.raises(RuntimeError, match="\\*"):
        create_app(make_settings(env="prod", auth_mode="oidc", oidc_issuer=ISSUER, oidc_client_id="a", oidc_client_secret="b",
                                 oidc_allowed_sub="1", public_url="https://x.test", allowed_hosts="*"))
    ok = create_app(make_settings(env="prod", auth_mode="oidc", oidc_issuer=ISSUER, oidc_client_id="a", oidc_client_secret="b",
                                  oidc_allowed_sub="1", public_url="https://x.test", allowed_hosts="x.test"))
    assert ok.docs_url is None and ok.openapi_url is None
