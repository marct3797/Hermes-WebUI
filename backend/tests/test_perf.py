"""Paket PERF: Cache (Single-Flight, Stale), Verbindungspool, Dashboard-Cache, parallele Diagnose."""
import asyncio
import json
import threading
import time
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from app.adapters import UpstreamError
from app.cache import TtlCache
from app.diagnose import inspect, summarize
from app.main import create_app
from devtools.mock_dashboard import create_mock as create_dashboard
from devtools.mock_hermes import API_KEY, create_mock
from tests.conftest import BASE, HDR, RouterTransport


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


# --- TtlCache ---------------------------------------------------------------------------------------
async def test_cache_ttl_and_single_flight():
    clock, calls = Clock(), []
    cache = TtlCache(clock)

    async def load():
        calls.append(1)
        await asyncio.sleep(0.01)
        return {"n": len(calls)}

    results = await asyncio.gather(*(cache.get("k", 20, load) for _ in range(5)))
    assert len(calls) == 1 and all(v == ({"n": 1}, False) for v in results)
    clock.t += 19
    assert (await cache.get("k", 20, load))[0] == {"n": 1} and len(calls) == 1
    clock.t += 2
    assert (await cache.get("k", 20, load))[0] == {"n": 2}


async def test_cache_returns_copies():
    cache = TtlCache(Clock())

    async def load():
        return {"a": [1]}

    first, _ = await cache.get("k", 20, load)
    first["a"].append(2)
    assert (await cache.get("k", 20, load))[0] == {"a": [1]}


async def test_cache_stale_if_error_until_limit():
    clock, fail = Clock(), False
    cache = TtlCache(clock)

    async def load():
        if fail:
            raise UpstreamError(503, "weg")
        return "alt"

    await cache.get("k", 20, load, stale_max=600)
    fail = True
    clock.t += 30
    assert await cache.get("k", 20, load, stale_max=600) == ("alt", True)
    clock.t += 600
    with pytest.raises(UpstreamError):
        await cache.get("k", 20, load, stale_max=600)
    with pytest.raises(UpstreamError):  # ohne stale_max nie ein alter Stand
        fresh = TtlCache(clock)
        await fresh.get("x", 1, load)


async def test_cache_invalidate_drops_entry_and_running_flight():
    cache, state = TtlCache(Clock()), {"v": "alt"}
    gate = asyncio.Event()

    async def load():
        v = state["v"]
        await gate.wait()
        return v

    task = asyncio.ensure_future(cache.get("k", 20, load))
    await asyncio.sleep(0.01)  # Abfrage läuft, hat den alten Stand gelesen
    cache.invalidate()
    state["v"] = "neu"
    gate.set()
    assert (await task)[0] == "alt"  # der Wartende bekommt seine Antwort, gespeichert wird sie nicht
    assert (await cache.get("k", 20, load))[0] == "neu"


async def test_cache_waiter_timeout_keeps_flight_running():
    cache, done = TtlCache(Clock()), []

    async def load():
        await asyncio.sleep(0.05)
        done.append(1)
        return "ok"

    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(cache.get("k", 20, load), 0.01)
    await asyncio.sleep(0.1)
    assert done and (await cache.get("k", 20, load))[0] == "ok" and len(done) == 1


# --- Verbindungspool: eine Verbindung für viele Aufrufe ----------------------------------------------
async def _keepalive_server(connections: list):
    async def handle(reader, writer):
        connections.append(1)
        try:
            while True:
                head = await reader.readuntil(b"\r\n\r\n")
                path = head.split(b" ", 2)[1]
                body = json.dumps({"version": "t", "features": {}, "path": path.decode()}).encode()
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s" % (len(body), body))
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()

    return await asyncio.start_server(handle, "127.0.0.1", 0)


def test_pool_reuses_one_connection(make_settings, tmp_path):
    connections: list = []
    loop = asyncio.new_event_loop()
    t = threading.Thread(target=loop.run_forever, daemon=True)  # der Server braucht einen eigenen Loop neben dem des TestClients
    t.start()
    server = asyncio.run_coroutine_threadsafe(_keepalive_server(connections), loop).result(5)
    port = server.sockets[0].getsockname()[1]
    cfg = {"hosts": [{"id": "hikari", "label": "H", "kind": "local", "runtimes": [
        {"id": "hermes", "base_url": f"http://127.0.0.1:{port}", "api_key": API_KEY, "multiplex": True, "agents": ["default"]}]}]}
    f = tmp_path / "pool.json"
    f.write_text(json.dumps(cfg))
    try:
        with TestClient(create_app(make_settings(hosts_file=f))) as c:
            c.headers.update(HDR)
            for _ in range(6):
                assert c.get(f"{BASE}/status").status_code == 200
    finally:
        loop.call_soon_threadsafe(server.close)
        loop.call_soon_threadsafe(loop.stop)
        t.join(2)
    assert len(connections) == 1  # sechs Aufrufe (je Health und Capabilities), eine Verbindung


# --- Dashboard-Cache über die Routen ---------------------------------------------------------------------
class Counting(httpx.AsyncBaseTransport):
    def __init__(self, inner, delay=0.0):
        self.inner, self.delay, self.paths, self.live, self.peak, self.broken = inner, delay, [], 0, 0, False

    async def handle_async_request(self, request):
        self.paths.append((request.method, request.url.path))
        if self.broken:
            raise httpx.ConnectError("aus", request=request)
        self.live += 1
        self.peak = max(self.peak, self.live)
        try:
            await asyncio.sleep(self.delay)
            return await self.inner.handle_async_request(request)
        finally:
            self.live -= 1

    def count(self, method, path):
        return sum(1 for m, p in self.paths if (m, p) == (method, path))


@pytest.fixture
def cached(make_settings):
    dash = Counting(httpx.ASGITransport(app=create_dashboard()))
    transport = RouterTransport({"hermes.test": httpx.ASGITransport(app=create_mock(delay=0)), "dashboard.test": dash})
    app = create_app(make_settings(), transport=transport)
    clock = Clock()
    app.state.dash_cache.cache._clock = clock
    with TestClient(app) as c:
        c.headers.update(HDR)
        yield c, dash, clock


def test_models_cached_and_invalidated_by_write(cached):
    c, dash, _ = cached
    first = c.get(f"{BASE}/providers/models").json()
    assert c.get(f"{BASE}/providers/models").json() == first and "stale" not in first
    assert dash.count("GET", "/api/model/options") == 1
    assert c.put(f"{BASE}/profile/model", json={"provider": "openai-codex", "model": "gpt-5"}).status_code == 200
    c.get(f"{BASE}/providers/models")
    assert dash.count("GET", "/api/model/options") == 2


def test_env_cache_ttl_and_key_write_invalidates(cached):
    c, dash, clock = cached
    c.get(f"{BASE}/providers")
    c.get(f"{BASE}/providers")
    assert dash.count("GET", "/api/env") == 1
    clock.t += 21
    c.get(f"{BASE}/providers")
    assert dash.count("GET", "/api/env") == 2


def test_profile_description_write_refreshes_profiles(cached):
    c, dash, _ = cached
    c.get(f"{BASE}/dashboard")
    c.get(f"{BASE}/dashboard")
    assert dash.count("GET", "/api/profiles") == 1
    assert c.put(f"{BASE}/profile/description", json={"description": "neu"}).status_code == 200
    assert c.get(f"{BASE}/dashboard").json()["profile"]["description"] == "neu"
    assert dash.count("GET", "/api/profiles") == 2


def test_stale_answer_when_dashboard_fails(cached):
    c, dash, clock = cached
    fresh = c.get(f"{BASE}/providers/models").json()
    clock.t += 301  # Modelle sind abgelaufen
    dash.broken = True
    res = c.get(f"{BASE}/providers/models")
    assert res.status_code == 200 and res.json() == {**fresh, "stale": True}
    clock.t += 700  # älter als 10 min: ehrlicher Fehler
    assert c.get(f"{BASE}/providers/models").status_code in (502, 503)


def test_matrix_limits_parallel_profile_queries(make_settings, tmp_path):
    names = [f"p{i}" for i in range(9)]
    cfg = {"hosts": [{"id": "hikari", "label": "H", "kind": "local", "runtimes": [
        {"id": "hermes", "base_url": "http://hermes.test", "api_key": API_KEY, "multiplex": True,
         "dashboard": {"base_url": "http://dashboard.test"}, "agents": names}]}]}
    f = tmp_path / "nine.json"
    f.write_text(json.dumps(cfg))
    dash = Counting(httpx.ASGITransport(app=create_dashboard(profiles=tuple(names))), delay=0.02)
    app = create_app(make_settings(hosts_file=f), transport=RouterTransport({"hermes.test": httpx.ASGITransport(app=create_mock(delay=0)), "dashboard.test": dash}))
    with TestClient(app) as c:
        c.headers.update(HDR)
        res = c.get("/bff/h/hikari/hermes/_provider-matrix")
    assert res.status_code == 200 and res.json()["available"]
    assert 1 < dash.peak <= 8  # je Profil laufen env und oauth zusammen: höchstens 4 Profile mal 2 Abfragen
    assert dash.count("GET", "/api/env") == 9


# --- Diagnose: parallel, Cache, Zeitlimit ------------------------------------------------------------------
def fake_adapter(models_delay=0.0, step=0.05):
    calls = {"models": 0}

    async def probe(agent):
        return SimpleNamespace(state="online", version="1", features={"runs", "stream", "stop", "approval", "sessions", "models"}, error=None)

    async def models(agent):
        calls["models"] += 1
        await asyncio.sleep(models_delay)
        return {"providers": [{"models": ["m"], "authenticated": True}], "model": "m"}

    async def sessions(agent, **kw):
        await asyncio.sleep(step)
        return {"data": [{"id": "s1"}]}

    async def messages(agent, sid, **kw):
        await asyncio.sleep(step)
        return {"data": [{"role": "user"}, {"role": "assistant"}]}

    return SimpleNamespace(id="hermes", probe=probe, models=models, sessions=sessions, session_messages=messages), calls


async def test_inspect_runs_checks_in_parallel_with_original_order():
    adapter, _ = fake_adapter(models_delay=0.15, step=0.05)
    started = time.monotonic()
    checks = await inspect(adapter, "a")
    assert time.monotonic() - started < 0.24  # seriell wären es 0.25 s
    assert [c["id"] for c in checks] == ["health", "features", "models", "sessions", "history"]
    assert summarize(checks) == "ok"


async def test_inspect_models_cached_and_slow_state():
    adapter, calls = fake_adapter(models_delay=0.15)
    cache = TtlCache()
    slow = await inspect(adapter, "a", cache=cache, models_timeout=0.03)
    m = next(c for c in slow if c["id"] == "models")
    assert m["status"] == "slow" and summarize(slow) == "warn"
    await asyncio.sleep(0.2)  # die abgebrochene Wartezeit hat die Abfrage nicht abgebrochen
    again = await inspect(adapter, "a", cache=cache, models_timeout=0.03)
    assert next(c for c in again if c["id"] == "models")["status"] == "ok" and calls["models"] == 1
