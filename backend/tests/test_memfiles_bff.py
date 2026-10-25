"""BFF-Weiterreichung MEMORY.md/USER.md an hostd (M2)."""
import hashlib
import json

import httpx
import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from app.auth import SESSION_COOKIE, User
from app.main import create_app
from devtools.mock_dashboard import create_mock as create_dashboard
from devtools.mock_hermes import create_mock
from tests.conftest import BASE, HDR, RouterTransport

H = f"{BASE}/hermes-memory"
TOKEN = "test-hostd-token-not-a-live-secret-123456"


def mem_hostd(*, old=False, fail=None):
    """Kleiner Fake-hostd mit dem festen Vertrag."""
    app = FastAPI()
    app.state.files = {"default": {"MEMORY.md": "a\n§\nb\n", "USER.md": ""}}
    app.state.fail = fail

    @app.middleware("http")
    async def auth(request: Request, call_next):
        if request.headers.get("authorization") != f"Bearer {TOKEN}":
            return httpx.Response(401).__class__  # pragma: no cover
        return await call_next(request)

    def doc(profile, name):
        content = app.state.files.setdefault(profile, {}).get(name, "")
        blob = content.encode()
        return {"name": name, "content": content, "sha256": hashlib.sha256(blob).hexdigest(),
                "size": len(blob), "mtime": "2026-01-01T00:00:00+00:00"}

    @app.get("/v1/profiles/{profile}/memory-files")
    async def listing(profile: str):
        if old:
            raise HTTPException(404, "no such endpoint")
        if app.state.fail:
            raise HTTPException(app.state.fail, "kaputt")
        rows = []
        for name in ("MEMORY.md", "USER.md"):
            d = doc(profile, name)
            rows.append({"name": name, "size": d["size"], "mtime": d["mtime"], "exists": bool(d["content"])})
        return {"files": rows}

    @app.get("/v1/profiles/{profile}/memory-files/{name}")
    async def read(profile: str, name: str):
        if old:
            raise HTTPException(404, "no such endpoint")
        return doc(profile, name)

    @app.put("/v1/profiles/{profile}/memory-files/{name}")
    async def write(profile: str, name: str, request: Request):
        if old:
            raise HTTPException(404, "no such endpoint")
        body = await request.json()
        cur = doc(profile, name)
        if body.get("expected_sha256") != cur["sha256"]:
            raise HTTPException(409, "changed")
        if len(body.get("content", "")) > 10_000:
            raise HTTPException(413, "too big")
        if "\x00" in body.get("content", ""):
            raise HTTPException(422, "bad")
        app.state.files[profile][name] = body["content"]
        d = doc(profile, name)
        if app.state.fail == "lie":  # hostd meldet Erfolg, speichert aber etwas anderes
            app.state.files[profile][name] = body["content"] + "x"
            d = doc(profile, name)
        return {**d, "backup": "MEMORY.md.bak-1"}
    return app


def logged(tmp_path, make_settings, hostd, hosts_extra=None):
    f = tmp_path / "hosts.json"
    rt = {"id": "hermes", "base_url": "http://hermes.test", "api_key": "k", "multiplex": True,
          "agents": ["default", "beta"], "dashboard": {"base_url": "http://dash.test"}}
    hosts = [{"id": "server", "hostd": {"base_url": "http://daemon.test", "token_env": "TEST_HOSTD"},
              "runtimes": [rt]},
             {"id": "nodaemon", "runtimes": [rt]}]
    if hosts_extra:
        hosts.extend(hosts_extra)
    f.write_text(json.dumps({"hosts": hosts}))
    settings = make_settings(hosts_file=f, auth_mode="oidc", oidc_issuer="https://id.test",
                             oidc_client_id="t", oidc_client_secret="t", oidc_allowed_sub="user",
                             public_url="http://testserver")
    dash = create_dashboard()
    app = create_app(settings, transport=RouterTransport(
        {"hermes.test": httpx.ASGITransport(app=create_mock(delay=0)),
         "dash.test": httpx.ASGITransport(app=dash),
         "daemon.test": httpx.ASGITransport(app=hostd)}))
    with TestClient(app) as c:
        s = app.state.sessions.create(User("user", "Test"))
        s.auth_time = app.state.sessions.now()
        c.cookies.set(SESSION_COOKIE, s.id)
        c.headers.update(HDR)
        c.audit_file = settings.audit_file
        yield c


@pytest.fixture
def env(tmp_path, make_settings, monkeypatch):
    monkeypatch.setenv("TEST_HOSTD", TOKEN)
    yield from logged(tmp_path, make_settings, mem_hostd())


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def test_listen_und_lesen_ohne_schreibrechte(env):
    env.app.state.sessions.get(env.cookies.get(SESSION_COOKIE)).auth_time = 0
    r = env.get(f"{H}/files")
    assert r.status_code == 200, r.text
    names = [f["name"] for f in r.json()["files"]]
    assert names == ["MEMORY.md", "USER.md"]
    r = env.get(f"{H}/files/MEMORY.md")
    assert r.status_code == 200 and r.json()["content"] == "a\n§\nb\n" and "sha256" in r.json()


def test_falscher_dateiname_404(env):
    assert env.get(f"{H}/files/NUL.md").status_code in (404, 422)
    assert env.get(f"{H}/files/../x").status_code in (404, 422)


def test_schreiben_braucht_frische_anmeldung(env):
    env.app.state.sessions.get(env.cookies.get(SESSION_COOKIE)).auth_time = 0
    r = env.put(f"{H}/files/MEMORY.md", json={"content": "neu\n", "expected_sha256": sha("a\n§\nb\n")})
    assert r.status_code == 401 and r.json()["detail"]["code"] == "step_up_required"


def test_schreiben_ok_schreibt_audit_ohne_inhalt(env):
    cur = env.get(f"{H}/files/MEMORY.md").json()
    r = env.put(f"{H}/files/MEMORY.md", json={"content": "neu\n", "expected_sha256": cur["sha256"]})
    assert r.status_code == 200, r.text
    assert env.get(f"{H}/files/MEMORY.md").json()["content"] == "neu\n"
    log = env.audit_file.read_text()
    assert "MEMORY.md" in log and "neu" not in log.replace("MEMORY.md", "")


def test_konflikt_409_mit_meldung(env):
    r = env.put(f"{H}/files/MEMORY.md", json={"content": "x\n", "expected_sha256": "0" * 64})
    assert r.status_code == 409 and "inzwischen" in r.text


def test_groesse_und_inhalt_422_413(env):
    cur = env.get(f"{H}/files/MEMORY.md").json()
    r = env.put(f"{H}/files/MEMORY.md", json={"content": "x" * 300_000, "expected_sha256": cur["sha256"]})
    assert r.status_code in (413, 422), r.text
    r = env.put(f"{H}/files/MEMORY.md", json={"content": "a\x00b", "expected_sha256": cur["sha256"]})
    assert r.status_code == 422, r.text


def test_ohne_hostd_503(tmp_path, make_settings, monkeypatch):
    monkeypatch.setenv("TEST_HOSTD", TOKEN)
    for c in logged(tmp_path, make_settings, mem_hostd()):
        r = c.get("/bff/h/nodaemon/hermes/default/hermes-memory/files")
        assert r.status_code == 503 and "Kein Host-Dienst" in r.text


def test_alter_hostd_501(tmp_path, make_settings, monkeypatch):
    monkeypatch.setenv("TEST_HOSTD", TOKEN)
    for c in logged(tmp_path, make_settings, mem_hostd(old=True)):
        assert c.get(f"{H}/files").status_code == 501
        assert "Aktualisiere" in c.get(f"{H}/files").text or "aktualisier" in c.get(f"{H}/files").text.lower()


def test_fehler_enthalten_keinen_pfad(env):
    r = env.get(f"{H}/files/MEMORY.md")
    assert "/home" not in r.text and "/profiles" not in r.text


@pytest.fixture
def lie_env(tmp_path, make_settings, monkeypatch):
    monkeypatch.setenv("TEST_HOSTD", TOKEN)
    yield from logged(tmp_path, make_settings, mem_hostd(fail="lie"))


def test_schreiben_prueft_den_hash_der_antwort(lie_env):
    cur = lie_env.get(f"{H}/files/MEMORY.md").json()
    r = lie_env.put(f"{H}/files/MEMORY.md", json={"content": "neu\n", "expected_sha256": cur["sha256"]})
    assert r.status_code == 502 and "nicht wie gesendet" in r.text
    assert not lie_env.audit_file.exists() or "hermes_memory.file" not in lie_env.audit_file.read_text()
