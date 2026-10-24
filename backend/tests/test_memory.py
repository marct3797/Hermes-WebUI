import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.memory import MemoryRegistry, norm_graph, norm_item, norm_stats, parse_memory_config
from devtools.mock_hermes import create_mock
from devtools.mock_hindsight import create_mock as create_hindsight
from tests.conftest import HDR, RouterTransport

M = "/bff/memory"


def memory_config(bank="hermes", key_env=None):
    p = {"id": "hindsight", "type": "hindsight", "label": "Hindsight", "base_url": "http://hindsight.test", "bank": bank}
    if key_env:
        p["api_key_env"] = key_env
    return {"providers": [p]}


@pytest.fixture
def memory_file(tmp_path):
    f = tmp_path / "memory.json"
    f.write_text(json.dumps(memory_config()))
    return f


@pytest.fixture
def mem_client(make_settings, memory_file, monkeypatch):
    def build(hindsight=None, **kw):
        transport = RouterTransport({"hermes.test": httpx.ASGITransport(app=create_mock()), "hindsight.test": httpx.ASGITransport(app=hindsight or create_hindsight())})
        return TestClient(create_app(make_settings(**{"memory_file": memory_file, **kw}), transport=transport))
    clients = []

    def make(**kw):
        c = build(**kw)
        c.__enter__()
        c.headers.update(HDR)
        clients.append(c)
        return c
    yield make
    for c in clients:
        c.__exit__(None, None, None)


# --- Konfiguration ---------------------------------------------------------------------------------------
def test_config_parse_and_secret_stays_out_of_repr():
    cfgs = parse_memory_config(memory_config(key_env="K"), {"K": "geheim"})
    assert cfgs["hindsight"].api_key == "geheim" and "geheim" not in repr(cfgs["hindsight"])


@pytest.mark.parametrize("raw", [
    [], {"providers": "x"}, {"providers": [1]},
    {"providers": [{"id": "Bad Id", "type": "hindsight", "base_url": "http://x"}]},
    {"providers": [{"id": "a", "type": "gibtsnicht", "base_url": "http://x"}]},
    {"providers": [{"id": "a", "type": "hindsight", "base_url": "ftp://x"}]},
    {"providers": [{"id": "a", "type": "hindsight", "base_url": "http://x", "bank": "../x"}]},
    {"providers": [{"id": "a", "type": "hindsight", "base_url": "http://x"}, {"id": "a", "type": "hindsight", "base_url": "http://y"}]},
])
def test_config_rejects_bad_entries(raw):
    with pytest.raises(ValueError):
        parse_memory_config(raw, {})


def test_registry_without_file_is_empty_and_keeps_last_good_config_on_error(tmp_path):
    assert MemoryRegistry(None).providers() == {}
    f = tmp_path / "m.json"
    f.write_text(json.dumps(memory_config()))
    reg = MemoryRegistry(f, {})
    assert "hindsight" in reg.providers()
    f.write_text("{kaputt")
    import os, time
    os.utime(f, (time.time() + 5, time.time() + 5))
    assert "hindsight" in reg.providers() and "memory.json" in reg.error


# --- Normalisierung ----------------------------------------------------------------------------------------
def test_norm_item_accepts_the_known_spellings():
    a = norm_item({"id": 1, "text": " Fakt ", "fact_type": "world", "entities": "A, B", "date": "2026-10-20T10:00:00Z", "tags": ["x", 3]})
    assert a["text"] == "Fakt" and a["kind"] == "world" and a["entities"] == ["A", "B"] and a["tags"] == ["x"] and a["at"] > 0
    b = norm_item({"content": "Anderer", "type": "experience", "entities": [{"canonical_name": "C"}, "D", 5], "occurred_start": 1_792_000_000})
    assert b["entities"] == ["C", "D"] and b["at"] == 1_792_000_000_000
    assert norm_item({"id": 1}) is None and norm_item({"text": ""}) is None


def test_norm_graph_drops_dangling_edges_and_caps_nodes():
    g = norm_graph({"nodes": [{"data": {"id": i, "label": f"n{i}"}} for i in range(5)] + [{"data": {"id": 1}}],
                    "edges": [{"data": {"source": 0, "target": 1}}, {"data": {"source": 0, "target": 4}}, {"data": {"source": 0, "target": 99}}], "total_units": 40}, cap=3)
    assert [n["id"] for n in g["nodes"]] == ["0", "1", "2"] and g["edges"] == [{"source": "0", "target": "1", "type": None}]
    assert g["total"] == 40 and g["truncated"] is True
    assert norm_graph("kaputt", 10) == {"nodes": [], "edges": [], "table_rows": [], "total": 0, "limit": 10, "returned": 0, "truncated": False, "edges_dropped": 0}


def test_norm_stats_flattens_numbers_and_breakdowns():
    rows = norm_stats({"total_nodes": 3, "ok": True, "nodes_by_fact_type": {"world": 2, "x": "y"}, "name": "b"})
    assert rows == [{"key": "total_nodes", "value": 3}, {"key": "nodes_by_fact_type.world", "value": 2}]


# --- Routen --------------------------------------------------------------------------------------------------
def test_providers_listing(mem_client):
    c = mem_client()
    body = c.get(M).json()
    assert body["providers"] == [{"id": "hindsight", "type": "hindsight", "label": "Hindsight", "bank": "hermes",
                                  "capabilities": ["stats", "items", "search", "graph", "entities", "models", "reflect"]}]
    assert body["config_error"] is None


def test_no_memory_file_means_no_providers(make_settings):
    with TestClient(create_app(make_settings())) as c:
        c.headers.update(HDR)
        assert c.get(M).json() == {"providers": [], "config_error": None}
        assert c.get(f"{M}/hindsight/stats").status_code == 404


def test_stats_items_search(mem_client):
    c = mem_client()
    assert {"key": "total_nodes", "value": 3} in c.get(f"{M}/hindsight/stats").json()["counts"]
    page = c.get(f"{M}/hindsight/items", params={"limit": 2}).json()
    assert page["total"] == 3 and len(page["items"]) == 2 and page["items"][0]["entities"] == ["Alex", "Forgejo"]
    assert [i["id"] for i in c.get(f"{M}/hindsight/items", params={"kind": "experience"}).json()["items"]] == ["u2"]
    hits = c.get(f"{M}/hindsight/search", params={"q": "Server Container"}).json()["items"]
    assert [h["id"] for h in hits] == ["u3"] and hits[0]["kind"] == "world"


def test_graph_entities_models(mem_client):
    c = mem_client()
    g = c.get(f"{M}/hindsight/graph").json()
    assert len(g["nodes"]) == 2 and len(g["edges"]) == 1  # Weltfakten; die Kante ins Leere fehlt
    assert [e["name"] for e in c.get(f"{M}/hindsight/entities").json()["items"]] == ["Alex", "Server"]
    e = c.get(f"{M}/hindsight/entities/en1").json()
    assert e["name"] == "Alex" and e["observations"][0]["text"].startswith("Alex taucht")
    assert c.get(f"{M}/hindsight/entities/nope").status_code == 404
    assert c.get(f"{M}/hindsight/models").json()["items"][0]["name"] == "Infrastruktur"


def test_reflect_is_post_only_audited_and_never_logs_the_question(mem_client, tmp_path):
    c = mem_client()
    assert c.get(f"{M}/hindsight/reflect").status_code == 405
    r = c.post(f"{M}/hindsight/reflect", json={"query": "Was läuft auf Server?"})
    assert r.status_code == 200 and "Server" in r.json()["text"] and r.json()["based_on"][0]["id"] == "u3"
    audit = (tmp_path / "audit.log").read_text()
    assert "memory.reflect" in audit and "Was läuft" not in audit


def test_bad_inputs_are_refused(mem_client):
    c = mem_client()
    assert c.get(f"{M}/hindsight/search").status_code == 422
    assert c.get(f"{M}/hindsight/items", params={"limit": 1000}).status_code == 422
    assert c.get(f"{M}/hindsight/entities/..%2Fx").status_code in (404, 422)
    assert c.get(f"{M}/UPPER/stats").status_code == 422
    assert c.post(f"{M}/hindsight/reflect", json={"query": ""}).status_code == 422


def test_unreachable_or_unauthorised_service_is_a_clean_error(mem_client, tmp_path, monkeypatch):
    c = mem_client(hindsight=create_hindsight(require_key="richtig"))
    assert c.get(f"{M}/hindsight/stats").status_code == 502  # 401 des Dienstes wird für den Browser zu 502
    f = tmp_path / "gone.json"
    f.write_text(json.dumps({"providers": [{"id": "weg", "type": "hindsight", "base_url": "http://nowhere.test", "bank": "hermes"}]}))
    c2 = mem_client(memory_file=f)
    assert c2.get(f"{M}/weg/stats").status_code == 502


def test_key_goes_out_as_bearer_but_never_into_a_response(make_settings, tmp_path, monkeypatch):
    f = tmp_path / "m.json"
    f.write_text(json.dumps(memory_config(key_env="HS_KEY")))
    monkeypatch.setenv("HS_KEY", "streng-geheim")
    transport = RouterTransport({"hermes.test": httpx.ASGITransport(app=create_mock()), "hindsight.test": httpx.ASGITransport(app=create_hindsight(require_key="streng-geheim"))})
    with TestClient(create_app(make_settings(memory_file=f), transport=transport)) as c:
        c.headers.update(HDR)
        r = c.get(f"{M}/hindsight/stats")
        assert r.status_code == 200 and "streng-geheim" not in r.text and "streng-geheim" not in c.get(M).text


def test_diagnose_reports_what_it_recognises(mem_client):
    report = mem_client().get(f"{M}/hindsight/diagnose").json()
    assert report["status"] == "ok" and [c["id"] for c in report["checks"]] == ["stats", "items", "graph", "entities"]


def test_diagnose_warns_when_the_bank_answers_in_an_unknown_form(mem_client):
    from fastapi import FastAPI
    odd = FastAPI()

    @odd.get("/v1/default/banks/{bank}/{rest:path}")
    async def anything(bank: str, rest: str):
        return {"völlig": "anders"}

    report = mem_client(hindsight=odd).get(f"{M}/hindsight/diagnose").json()
    assert report["status"] == "warn" and all(c["status"] == "warn" for c in report["checks"])


def test_graph_edges_keep_a_numeric_weight_and_drop_nonsense():
    from app.memory import norm_graph
    g = norm_graph({"nodes": [{"data": {"id": "a"}}, {"data": {"id": "b"}}, {"data": {"id": "c"}}],
                    "edges": [{"data": {"source": "a", "target": "b", "linkType": "semantic", "weight": 0.8}},
                              {"data": {"source": "b", "target": "c", "linkType": "entity", "weight": "hoch"}},
                              {"data": {"source": "a", "target": "c", "linkType": "temporal", "weight": True}}]}, 50)
    assert [e.get("weight") for e in g["edges"]] == [0.8, None, None]


# --- Graph: echte Hindsight-Antwort (bereinigt, tests/fixtures) --------------------------------------------
REAL = json.loads((Path(__file__).parent / "fixtures" / "real_hindsight_graph_world.json").read_text("utf-8"))


def test_real_graph_keeps_date_context_entities_and_text():
    g = norm_graph(REAL, 40, "world")
    first = g["nodes"][0]
    assert first["date"] == "2026-10-23T22:54:54.140000+00:00" and first["kind"] == "world"
    assert first["context"] == "Beispielkontext A"
    assert first["entities"] == ["Beispiel-Entität 1", "Beispiel-Entität 5"]  # Typ-Präfixe und Doppelte weg
    assert first["text"].startswith("Beispiel-Erinnerung 1") and len(first["text"]) <= 600
    assert all("color" not in n for n in g["nodes"]) and all(len(n["entities"]) <= 12 for n in g["nodes"])
    assert (g["total"], g["limit"], g["returned"], g["truncated"]) == (44272, 40, 25, True)
    assert len(g["table_rows"]) == 25 and g["table_rows"][0]["date"] == first["date"] and g["table_rows"][0]["kind"] == "world"


def test_real_graph_maps_link_types_and_never_dangles():
    g = norm_graph(REAL, 40, "world")
    assert {e["type"] for e in g["edges"]} == {"semantic", "temporal", "causal"}  # caused_by wurde causal
    ids = {n["id"] for n in g["nodes"]}
    assert all(e["source"] in ids and e["target"] in ids for e in g["edges"]) and g["edges_dropped"] == 0
    assert all("weight" in e for e in g["edges"])


def test_graph_keeps_unknown_link_type_and_trims_texts():
    raw = {"nodes": [{"data": {"id": "a", "text": "x" * 900}}, {"data": {"id": "b"}}],
           "edges": [{"data": {"source": "a", "target": "b", "linkType": "rätselhaft", "entityName": "Alex", "ueberraschung": 1}}]}
    g = norm_graph(raw, 10)
    assert g["edges"] == [{"source": "a", "target": "b", "type": "rätselhaft", "entity": "Alex"}]
    assert len(g["nodes"][0]["text"]) == 600 and g["nodes"][0]["text"].endswith("…")


def test_graph_limits_edges_to_twelve_per_node_strongest_first():
    n = 30
    nodes = [{"data": {"id": f"n{i}"}} for i in range(n)]
    edges = [{"data": {"source": f"n{i}", "target": f"n{j}", "linkType": "entity", "weight": 1 + (i + j) / 100}} for i in range(n) for j in range(i + 1, n)]
    g = norm_graph({"nodes": nodes, "edges": edges}, n)
    assert len(g["edges"]) <= 12 * n and g["edges_dropped"] == len(edges) - len(g["edges"]) > 0
    assert max(e["weight"] for e in g["edges"]) == max(e["data"]["weight"] for e in edges)  # die stärkste bleibt


def test_graph_route_sends_type_and_filters_and_caches(mem_client):
    h = create_hindsight()
    c = mem_client(hindsight=h)
    g = c.get(f"{M}/hindsight/graph", params={"type": "experience"}).json()
    assert [n["kind"] for n in g["nodes"]] == ["experience"] and g["table_rows"][0]["context"] == "Chat"
    assert h.state.graph_calls[-1]["type"] == "experience" and h.state.graph_calls[-1]["limit"] == "500"
    c.get(f"{M}/hindsight/graph", params={"type": "experience"})
    assert len(h.state.graph_calls) == 1  # aus dem Speicher
    c.get(f"{M}/hindsight/graph", params={"type": "experience", "refresh": 1})
    c.get(f"{M}/hindsight/graph", params={"type": "experience", "q": "WebUI"})
    assert len(h.state.graph_calls) == 3 and h.state.graph_calls[-1]["q"] == "WebUI"


def test_graph_cache_expires_and_is_bounded():
    from app.memory import TTLCache
    now = [0.0]
    c = TTLCache(2, clock=lambda: now[0])
    c.put("a", 1); c.put("b", 2); c.put("c", 3)
    assert c.get("a", 60) is None and c.get("c", 60) == 3
    now[0] = 61
    assert c.get("c", 60) is None


def test_stats_are_cached_for_a_moment(mem_client):
    calls = []
    h = create_hindsight()

    @h.middleware("http")
    async def count(request, call_next):
        calls.append(request.url.path)
        return await call_next(request)
    c = mem_client(hindsight=h)
    c.get(f"{M}/hindsight/stats"); c.get(f"{M}/hindsight/stats")
    assert sum(p.endswith("/stats") for p in calls) == 1
    c.get(f"{M}/hindsight/stats", params={"refresh": 1})
    assert sum(p.endswith("/stats") for p in calls) == 2


@pytest.mark.parametrize("params", [{"type": "opinion"}, {"limit": 2001}, {"limit": 0}, {"q": "x" * 201}, {"tags_match": "none"},
                                    {"tags": [f"t{i}" for i in range(11)]}, {"tags": ["x" * 65]}, {"tags": ["a;b"]}])
def test_graph_route_validates(mem_client, params):
    assert mem_client().get(f"{M}/hindsight/graph", params=params).status_code == 422


def test_graph_route_accepts_the_maximum_and_forwards_tags(mem_client):
    h = create_hindsight()
    c = mem_client(hindsight=h)
    assert c.get(f"{M}/hindsight/graph", params={"limit": 2000, "tags": ["session:abc", "infra"], "tags_match": "all"}).status_code == 200
    assert h.state.graph_calls[-1]["tags_match"] == "all" and h.state.graph_calls[-1]["limit"] == "2000"


def test_timeseries_route(mem_client):
    c = mem_client()
    assert c.get(f"{M}/hindsight/timeseries", params={"type": "observation", "period": "30d"}).json()["points"] == [
        {"t": "2026-10-20T00:00:00+00:00", "count": 2}, {"t": "2026-10-21T00:00:00+00:00", "count": 0}, {"t": "2026-10-22T00:00:00+00:00", "count": 1}]
    assert c.get(f"{M}/hindsight/timeseries", params={"period": "evil"}).status_code == 422


def test_thousand_node_graph_stays_far_below_two_megabytes(mem_client, monkeypatch):
    monkeypatch.setenv("MOCK_GRAPH_NODES", "1000")
    r = mem_client().get(f"{M}/hindsight/graph", params={"limit": 1000})
    g = r.json()
    assert len(g["nodes"]) == 1000 and len(g["edges"]) <= 12000 and g["edges_dropped"] > 0
    assert len(r.content) < 2_000_000, len(r.content)


def test_large_json_is_gzipped_small_is_not(mem_client, monkeypatch):
    monkeypatch.setenv("MOCK_GRAPH_NODES", "300")
    c = mem_client()
    big = c.get(f"{M}/hindsight/graph", headers={"Accept-Encoding": "gzip"})
    assert big.headers.get("content-encoding") == "gzip" and len(big.json()["nodes"]) == 300
    assert "content-encoding" not in c.get(f"{M}", headers={"Accept-Encoding": "gzip"}).headers
