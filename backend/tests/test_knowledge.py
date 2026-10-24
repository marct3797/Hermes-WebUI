import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

import app.knowledge as kn
from app.adapters import UpstreamError
from app.knowledge import KnowledgeRegistry, build_url, parse_knowledge_config, slugify
from app.main import create_app
from devtools.mock_hermes import create_mock as create_hermes
from devtools.mock_rag import create_mock as create_rag
from tests.conftest import HDR, RouterTransport

REAL = Path(__file__).parent / "fixtures" / "real"
K = "/bff/knowledge"
TPL = "https://git.example.com/{repo}/src/commit/{commit}/{path}"


def real(name):
    return json.loads((REAL / name).read_text("utf-8"))


def cfg(**kw):
    return {"providers": [{"id": "rag", "type": "hermes-rag", "label": "Wissen", "base_url": "http://rag.test", "chroma_url": "http://chroma.test", "link_template": TPL, **kw}]}


def real_mock(**kw):
    """Der Mock, gefüllt mit den echten (bereinigten) Chroma-Metadaten."""
    return create_rag(chunks=real("chroma_get_clean.json")["metadatas"], collection=real("rag_stats_clean.json")["collection"], **kw)


@pytest.fixture
def make(make_settings, tmp_path):
    clients = []

    def build(rag=None, config=None, **kw):
        f = tmp_path / "knowledge.json"
        f.write_text(json.dumps(config or cfg()))
        rag = rag or real_mock()
        t = RouterTransport({"hermes.test": httpx.ASGITransport(app=create_hermes()), "rag.test": httpx.ASGITransport(app=rag), "chroma.test": httpx.ASGITransport(app=rag)})
        c = TestClient(create_app(make_settings(knowledge_file=f, **kw), transport=t))
        c.__enter__()
        c.headers.update(HDR)
        clients.append(c)
        c.rag = rag
        return c
    yield build
    for c in clients:
        c.__exit__(None, None, None)


# --- Konfiguration -----------------------------------------------------------------------------------
def test_config_parse_and_optional_fields():
    c = parse_knowledge_config(cfg())["rag"]
    assert (c.base_url, c.chroma_url, c.link_template) == ("http://rag.test", "http://chroma.test", TPL)
    bare = parse_knowledge_config({"providers": [{"id": "a", "type": "hermes-rag", "base_url": "https://x.test/"}]})["a"]
    assert (bare.base_url, bare.chroma_url, bare.label) == ("https://x.test", "", "a")


@pytest.mark.parametrize("raw", [
    [], {"providers": "x"}, {"providers": [1]},
    {"providers": [{"id": "Bad Id", "type": "hermes-rag", "base_url": "http://x"}]},
    {"providers": [{"id": "a", "type": "gibtsnicht", "base_url": "http://x"}]},
    {"providers": [{"id": "a", "type": "hermes-rag", "base_url": "ftp://x"}]},
    {"providers": [{"id": "a", "type": "hermes-rag", "base_url": "http://user:pw@x"}]},
    {"providers": [{"id": "a", "type": "hermes-rag", "base_url": "http://x", "chroma_url": "file:///etc"}]},
    {"providers": [{"id": "a", "type": "hermes-rag", "base_url": "http://x", "link_template": "https://g/{unbekannt}"}]},
    {"providers": [{"id": "a", "type": "hermes-rag", "base_url": "http://x"}, {"id": "a", "type": "hermes-rag", "base_url": "http://y"}]},
])
def test_config_rejects_bad_entries(raw):
    with pytest.raises(ValueError):
        parse_knowledge_config(raw)


def test_registry_missing_file_is_empty_and_bad_file_keeps_last_good(tmp_path):
    assert KnowledgeRegistry(None).providers() == {}
    f = tmp_path / "k.json"
    reg = KnowledgeRegistry(f)
    assert reg.providers() == {} and reg.error is None  # Datei fehlt: kein Fehler
    f.write_text(json.dumps(cfg()))
    assert "rag" in reg.providers()
    f.write_text("{kaputt")
    import os, time
    os.utime(f, (time.time() + 5, time.time() + 5))
    assert "rag" in reg.providers() and "knowledge.json" in reg.error


def test_several_providers(make):
    two = {"providers": [*cfg()["providers"], {"id": "zwei", "type": "hermes-rag", "base_url": "http://rag.test"}]}
    r = make(config=two).get(K).json()
    assert [p["id"] for p in r["providers"]] == ["rag", "zwei"] and [p["has_sources"] for p in r["providers"]] == [True, False]


# --- Hilfsfunktionen ---------------------------------------------------------------------------------
def test_build_url_encodes_parts_and_needs_every_placeholder():
    meta = {"repo": "example-org/mein repo", "commit": "abc", "path": "a b/ü#?.md"}
    assert build_url(TPL, meta) == "https://git.example.com/example-org/mein%20repo/src/commit/abc/a%20b/%C3%BC%23%3F.md"
    assert build_url(TPL, {**meta, "commit": None}) is None and build_url(TPL, {**meta, "path": ""}) is None
    assert build_url("", meta) is None and build_url(TPL, {**meta, "path": "../x"}) is None
    assert build_url("{repo}", meta) is None  # kein http(s) am Anfang
    assert build_url("javascript:{path}", meta) is None


def test_slugify():
    assert slugify("Notiz Größe & Äpfel!") == "notiz-groesse-aepfel" and slugify("!!!") == ""


# --- Anbieter gegen die echten Formen ----------------------------------------------------------------
def test_stats_with_real_shapes(make):
    s = make().get(f"{K}/rag/stats").json()
    assert s["reachable"] is True and s["embedding_model"] == "BAAI/bge-m3" and (s["chunk_size"], s["chunk_overlap"]) == (512, 50)
    assert s["count"] == len(real("chroma_get_clean.json")["metadatas"])
    assert (s["documents"], s["sources"]) == (4, 3)  # docs (2 Dokumente), skills, manual


def test_sources_and_documents_from_real_chroma_rows(make):
    c = make()
    src = c.get(f"{K}/rag/sources").json()
    assert src["available"] and src["scanned_chunks"] == 10 and not src["truncated"]
    assert src["items"] == [{"source": "docs", "chunks": 5, "documents": 2, "repos": ["example-org/docs"]},
                            {"source": "skills", "chunks": 4, "documents": 1, "repos": ["example-org/skills"]},
                            {"source": "manual", "chunks": 1, "documents": 1, "repos": []}]
    d = c.get(f"{K}/rag/documents").json()
    assert d["total"] == 4 and [x["sync_id"] for x in d["items"]] == ["docs:guide/intro.md", "docs:guide/setup.md", "manual:notiz-1", "skills:x/SKILL.md"]
    manual = next(x for x in d["items"] if x["source"] == "manual")
    assert manual["title"] == "Notiz 1" and manual["path"] is None and manual["chunks"] == 1  # nur source, sync_id, title
    assert [x["sync_id"] for x in c.get(f"{K}/rag/documents", params={"source": "skills"}).json()["items"]] == ["skills:x/SKILL.md"]
    assert [x["sync_id"] for x in c.get(f"{K}/rag/documents", params={"q": "NOTIZ"}).json()["items"]] == ["manual:notiz-1"]  # Titel, Groß/Klein egal
    assert c.get(f"{K}/rag/documents", params={"q": "SETUP"}).json()["total"] == 1  # Pfad
    page = c.get(f"{K}/rag/documents", params={"limit": 1, "offset": 1}).json()
    assert page["total"] == 4 and [x["sync_id"] for x in page["items"]] == ["docs:guide/setup.md"]


def test_chunks_without_sync_id_or_metadata_count_as_one_document(make):
    rag = create_rag(chunks=[None, {"source": "docs"}, {"path": "x.md"}])
    d = make(rag=rag).get(f"{K}/rag/documents").json()
    assert d["total"] == 1 and d["items"][0]["sync_id"] == "(ohne Kennung)" and d["items"][0]["chunks"] == 3


def test_scan_pages_and_stops_at_the_limit(make, monkeypatch):
    monkeypatch.setattr(kn, "PAGE", 4)
    rag = create_rag(chunks=[{"source": "s", "sync_id": f"s:{i}"} for i in range(10)])
    r = make(rag=rag).get(f"{K}/rag/sources").json()
    assert r["scanned_chunks"] == 10 and not r["truncated"]
    assert [c[1]["offset"] for c in rag.state.calls if c[0].endswith("/get")] == [0, 4, 8]
    monkeypatch.setattr(kn, "MAX_SCAN", 8)
    rag2 = create_rag(chunks=[{"source": "s", "sync_id": f"s:{i}"} for i in range(10)])
    r = make(rag=rag2).get(f"{K}/rag/sources").json()
    assert r["truncated"] is True and r["scanned_chunks"] == 8


def test_scan_is_cached_and_writes_drop_the_cache(make):
    c = make()
    for _ in range(3):
        c.get(f"{K}/rag/sources")
    gets = lambda: len([x for x in c.rag.state.calls if x[0].endswith("/get")])
    assert gets() == 1
    assert c.post(f"{K}/rag/ingest", json={"title": "Neu", "text": "Hallo"}).status_code == 200
    n = gets()  # der Doppelt-Test liest frisch
    assert c.get(f"{K}/rag/sources").json()["items"][-1]["source"] == "manual"
    assert gets() == n + 1
    c.get(f"{K}/rag/sources")
    assert gets() == n + 1
    assert c.post(f"{K}/rag/delete", json={"sync_id": "manual:neu"}).status_code == 200
    c.get(f"{K}/rag/sources")
    assert gets() == n + 2


def test_cache_expires(make):
    c = make(knowledge_cache_s=0)
    c.get(f"{K}/rag/sources"); c.get(f"{K}/rag/sources")
    assert len([x for x in c.rag.state.calls if x[0].endswith("/get")]) == 2


def test_without_chroma_url_sources_and_documents_say_why_but_search_works(make):
    c = make(config=cfg(chroma_url=""))
    for p in ("sources", "documents"):
        r = c.get(f"{K}/rag/{p}").json()
        assert r["available"] is False and "chroma_url" in r["reason"] and r["items"] == []
    s = c.get(f"{K}/rag/stats").json()
    assert s["reachable"] and s["documents"] is None and s["sources"] is None
    assert c.post(f"{K}/rag/search", json={"query": "guide", "source": "frei"}).status_code == 200


def test_search_with_real_query_shape_builds_links(make):
    rag = real_mock(results=real("rag_query_clean.json")["results"])
    r = make(rag=rag).post(f"{K}/rag/search", json={"query": "Forgejo Runner", "top_k": 5, "source": "infrastruktur-doku"}).json()["results"]
    assert rag.state.calls[-1] == ("/api/v1/query", {"query": "Forgejo Runner", "top_k": 5, "source": "infrastruktur-doku"})
    assert len(r) == 2 and r[0]["path"] == "referenzen/forgejo-runner.md" and r[0]["score"] == pytest.approx(0.7183, abs=1e-4)
    assert r[0]["url"] == "https://git.example.com/example-org/infrastruktur-doku/src/commit/95c578367132c986303b12010aa5da7a39de51a0/referenzen/forgejo-runner.md"
    assert set(r[0]) == {"text", "score", "source", "repo", "path", "commit", "sync_id", "url"}


def test_search_truncates_text_and_omits_url_without_template_or_commit(make):
    hits = [{"content": "x" * 5000, "score": 0.5, "metadata": {"source": "m", "sync_id": "manual:a", "title": "A"}}, {"content": "ohne Metadaten", "score": 0.4, "metadata": None}]
    r = make(rag=real_mock(results=hits)).post(f"{K}/rag/search", json={"query": "x"}).json()["results"]
    assert len(r[0]["text"]) == 1200 and r[0]["url"] is None and r[1]["path"] is None
    r = make(rag=real_mock(results=real("rag_query_clean.json")["results"]), config=cfg(link_template="")).post(f"{K}/rag/search", json={"query": "x"}).json()["results"]
    assert all(h["url"] is None for h in r)


def test_ingest_builds_metadata_and_409_on_duplicate(make, tmp_path):
    c = make()
    r = c.post(f"{K}/rag/ingest", json={"title": "Meine Notiz Größe", "text": "Geheimer Inhalt 123", "source": "notizen"})
    assert r.status_code == 200 and r.json() == {"ok": True, "source": "notizen", "sync_id": "manual:meine-notiz-groesse", "title": "Meine Notiz Größe"}
    assert c.rag.state.calls[-1][1] == {"text": "Geheimer Inhalt 123", "metadata": {"source": "notizen", "sync_id": "manual:meine-notiz-groesse", "title": "Meine Notiz Größe"}}
    dup = c.post(f"{K}/rag/ingest", json={"title": "meine notiz größe", "text": "y"})
    assert dup.status_code == 409 and "manual:meine-notiz-groesse" in dup.json()["detail"]
    assert c.post(f"{K}/rag/ingest", json={"title": "!!!", "text": "y"}).status_code == 422
    audit = (tmp_path / "audit.log").read_text()
    assert "knowledge.ingest" in audit and "manual:meine-notiz-groesse" in audit and "Geheimer Inhalt" not in audit and '"chars":19' in audit


def test_delete_goes_by_sync_id_only_and_is_audited(make, tmp_path):
    c = make()
    r = c.post(f"{K}/rag/delete", json={"sync_id": "docs:guide/intro.md"})
    assert r.json() == {"ok": True, "deleted": 3}
    assert c.rag.state.calls[-1] == ("/api/v1/delete", {"where": {"sync_id": "docs:guide/intro.md"}})
    assert [d["sync_id"] for d in c.get(f"{K}/rag/documents").json()["items"]] == ["docs:guide/setup.md", "manual:notiz-1", "skills:x/SKILL.md"]
    assert c.post(f"{K}/rag/delete", json={"where": {}}).status_code == 422  # kein freier Filter
    assert c.post(f"{K}/rag/delete", json={"sync_id": "a", "where": {}}).json() == {"ok": True, "deleted": 0}  # `where` wird ignoriert
    assert c.rag.state.calls[-1] == ("/api/v1/delete", {"where": {"sync_id": "a"}})
    audit = (tmp_path / "audit.log").read_text()
    assert "knowledge.delete" in audit and "docs:guide/intro.md" in audit


def test_delete_does_not_assume_the_answer_shape(make):
    assert make(rag=real_mock(delete_body={"status": "ok"})).post(f"{K}/rag/delete", json={"sync_id": "a"}).json() == {"ok": True}
    assert make(rag=real_mock(delete_body="fertig")).post(f"{K}/rag/delete", json={"sync_id": "a"}).json() == {"ok": True}


# --- Validierung, Auth, Fehler -----------------------------------------------------------------------
@pytest.mark.parametrize("path,body", [
    ("search", {"query": ""}), ("search", {"query": "x" * 501}), ("search", {"query": "x", "top_k": 0}), ("search", {"query": "x", "top_k": 21}),
    ("ingest", {"title": "", "text": "x"}), ("ingest", {"title": "x" * 121, "text": "x"}), ("ingest", {"title": "t", "text": ""}), ("ingest", {"title": "t", "text": "x" * 20001}),
    ("ingest", {"title": "t\n", "text": "x", "source": "a\x00b"}), ("delete", {"sync_id": ""}), ("delete", {"sync_id": "x" * 301}), ("delete", {"sync_id": "a\x07b"}),
])
def test_validation(make, path, body):
    assert make().post(f"{K}/rag/{path}", json=body).status_code == 422


def test_limits_accepted_at_the_edge(make):
    c = make()
    assert c.post(f"{K}/rag/search", json={"query": "x" * 500, "top_k": 20}).status_code == 200
    assert c.post(f"{K}/rag/ingest", json={"title": "t" * 120, "text": "x" * 20000}).status_code == 200


def test_unknown_provider_and_bad_id(make):
    c = make()
    assert c.get(f"{K}/nope/stats").status_code == 404 and c.get(f"{K}/BAD ID/stats").status_code == 422


def test_writes_need_csrf_header(make):
    c = make()
    del c.headers["X-Requested-With"]
    assert c.post(f"{K}/rag/delete", json={"sync_id": "a"}).status_code == 403
    assert c.post(f"{K}/rag/ingest", json={"title": "a", "text": "b"}).status_code == 403
    assert c.get(f"{K}/rag/stats").status_code == 200


class Broken(httpx.AsyncBaseTransport):
    def __init__(self, handler):
        self.handler = handler

    async def handle_async_request(self, request):
        return self.handler(request)


def broken_client(make_settings, tmp_path, handler):
    f = tmp_path / "k.json"
    f.write_text(json.dumps(cfg()))
    c = TestClient(create_app(make_settings(knowledge_file=f), transport=Broken(handler)))
    c.__enter__()
    c.headers.update(HDR)
    return c


def boom_timeout(request):
    raise httpx.ReadTimeout("zu langsam", request=request)


def boom_connect(request):
    raise httpx.ConnectError("rag.test:8000 verweigert", request=request)


@pytest.mark.parametrize("handler,status,reason", [
    (boom_connect, 502, "nicht erreichbar"), (boom_timeout, 504, "nicht rechtzeitig"),
    (lambda r: httpx.Response(500, text="Traceback in /srv/intern/rag.py"), 502, "Fehler 500"),
    (lambda r: httpx.Response(302, headers={"location": "http://intern.example/"}), 502, "Fehler 302"),
    (lambda r: httpx.Response(200, text="<html>kein json"), 502, "kein JSON"),
    (lambda r: httpx.Response(200, json=["unbekannt"]), 502, "unbekannt"),
])
def test_upstream_failures_are_honest_and_leak_no_address(make_settings, tmp_path, handler, status, reason):
    c = broken_client(make_settings, tmp_path, handler)
    try:
        r = c.post(f"{K}/rag/search", json={"query": "x"})
        assert r.status_code == status and reason in r.json()["detail"]
        assert "rag.test" not in r.text and "Traceback" not in r.text and "intern" not in r.text
        s = c.get(f"{K}/rag/stats").json()  # Fehler sind bei der Statistik Daten, kein HTTP-Fehler
        assert s["reachable"] is False and reason in s["reason"] and "rag.test" not in s["reason"]
        assert c.get(f"{K}/rag/sources").status_code in (502, 504)
        if reason != "unbekannt":  # eine unbekannte Antwortform beim Löschen gilt als Erfolg (die Form ist nicht erfasst)
            assert c.post(f"{K}/rag/delete", json={"sync_id": "a"}).status_code in (502, 504)
    finally:
        c.__exit__(None, None, None)


def test_unknown_collection_is_reported(make):
    c = make(rag=create_rag(chunks=[], collection="andere"), config=cfg(collection="fehlt"))
    r = c.get(f"{K}/rag/sources")
    assert r.status_code == 502 and "Sammlung" in r.json()["detail"]
    assert c.get(f"{K}/rag/stats").json()["documents"] is None  # Statistik bleibt trotzdem nutzbar
