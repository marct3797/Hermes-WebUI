"""Wissen: Dokument-Detailansicht (Volltext aus den Chunks) und Ersetzen gegen devtools/mock_rag2.py."""
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.knowledge import DOC_CHUNKS, join_chunks
from app.main import create_app
from devtools import mock_rag2
from devtools.mock_hermes import create_mock as create_hermes
from tests.conftest import HDR, RouterTransport

K = "/bff/knowledge/rag"
INTRO = "docs:guide/intro.md"
NOTE = "manual:notiz"


@pytest.fixture
def make(make_settings, tmp_path):
    clients = []

    def build(chroma=True, rag=None, **kw):
        f = tmp_path / "knowledge.json"
        f.write_text(json.dumps({"providers": [{"id": "rag", "type": "hermes-rag", "label": "Wissen", "base_url": "http://rag.test", **({"chroma_url": "http://chroma.test"} if chroma else {})}]}))
        rag = rag or mock_rag2.create_mock()
        t = RouterTransport({"hermes.test": httpx.ASGITransport(app=create_hermes()), "rag.test": httpx.ASGITransport(app=rag), "chroma.test": httpx.ASGITransport(app=rag)})
        c = TestClient(create_app(make_settings(knowledge_file=f, knowledge_cache_s=0, **kw), transport=t))
        c.__enter__()
        c.headers.update(HDR)
        c.rag = rag
        clients.append(c)
        return c
    yield build
    for c in clients:
        c.__exit__(None, None, None)


def test_join_chunks_removes_overlap_and_keeps_text():
    text = "Eins zwei drei vier fuenf sechs sieben acht neun zehn elf zwoelf dreizehn vierzehn."
    assert join_chunks(mock_rag2.split(text)) == text
    assert join_chunks(["a" * 30, "b" * 30]) == "a" * 30 + "\n\n" + "b" * 30  # ohne Überlappung trennt eine Leerzeile
    assert join_chunks([]) == "" and join_chunks(["nur"]) == "nur"
    assert join_chunks(["x" * 40, "x" * 40 + "y"]) == "x" * 40 + "y"  # volle Wiederholung am Rand


def test_document_detail_full_text_metadata_and_parts(make):
    c = make()
    d = c.get(f"{K}/documents/{INTRO}").json()  # Schrägstrich und Doppelpunkt in der Kennung
    assert d["sync_id"] == INTRO and d["source"] == "docs" and d["repo"] == "example-org/docs" and d["path"] == "guide/intro.md"
    assert d["text"] == mock_rag2.INTRO_TEXT and d["chunks"] == len(d["parts"]) > 2 and d["truncated"] is False and d["editable"] is True
    assert [p["index"] for p in d["parts"]] == list(range(d["chunks"]))
    body = c.rag.state.calls[-1][1]
    assert body["where"] == {"sync_id": INTRO} and body["limit"] == DOC_CHUNKS and set(body["include"]) == {"documents", "metadatas"}
    n = c.get(f"{K}/documents/{NOTE}").json()
    assert n["title"] == "Notiz" and n["text"].startswith("Alpha beta")


def test_document_not_found_validation_and_no_chroma(make):
    c = make()
    assert c.get(f"{K}/documents/gibts:nicht").status_code == 404
    assert c.get(f"{K}/documents/{'x' * 301}").status_code == 422
    assert c.get(f"{K}/documents/a%00b").status_code == 422
    assert c.get("/bff/knowledge/zzz/documents/x").status_code == 404
    c.rag.state.chunks = [{"id": f"{i:08d}-0000-0000-0000-000000000000", "meta": {"sync_id": "big", "source": "x"}, "text": f"t{i}"} for i in range(DOC_CHUNKS)]
    big = c.get(f"{K}/documents/big").json()
    assert big["truncated"] is True and big["editable"] is False
    assert c.put(f"{K}/documents/big", json={"text": "neu"}).status_code == 409
    no = make(chroma=False)
    r = no.get(f"{K}/documents/{INTRO}")
    assert r.status_code == 409 and "chroma_url" in r.json()["detail"]


def test_replace_ingests_first_then_removes_exactly_the_old_chunks(make, tmp_path):
    c = make()
    other = [x for x in c.rag.state.chunks if x["meta"]["sync_id"] == INTRO]
    old_ids = [x["id"] for x in c.rag.state.chunks if x["meta"]["sync_id"] == NOTE]
    r = c.put(f"{K}/documents/{NOTE}", json={"title": "Notiz neu", "text": "Ganz neuer Geheimtext mit etwas mehr Länge als ein Chunk fasst, damit es mehrere gibt."})
    assert r.status_code == 200 and r.json()["removed"] == len(old_ids) and r.json()["chunks"] >= 2
    order = [p for p, _ in c.rag.state.calls if p in ("/api/v1/ingest",) or p.endswith("/delete")]
    assert order == ["/api/v1/ingest", f"/api/v1/collections/{mock_rag2.CID}/delete"]  # erst einspeisen, dann entfernen
    ingest = next(b for p, b in c.rag.state.calls if p == "/api/v1/ingest")
    assert ingest["metadata"] == {"source": "manual", "sync_id": NOTE, "title": "Notiz neu"}
    assert [b for p, b in c.rag.state.calls if p.endswith("/delete")][0] == {"ids": sorted(old_ids)}
    assert not any(i in {x["id"] for x in c.rag.state.chunks} for i in old_ids)
    assert [x["id"] for x in c.rag.state.chunks if x["meta"]["sync_id"] == INTRO] == [x["id"] for x in other]  # andere Dokumente unberührt
    assert c.get(f"{K}/documents/{NOTE}").json()["text"].startswith("Ganz neuer Geheimtext") and c.get(f"{K}/documents/{NOTE}").json()["title"] == "Notiz neu"
    audit = (tmp_path / "audit.log").read_text()
    assert "knowledge.update" in audit and NOTE in audit and "Geheimtext" not in audit and '"chars":' in audit


def test_replace_keeps_title_and_repo_metadata_when_not_given(make):
    c = make()
    assert c.put(f"{K}/documents/{INTRO}", json={"text": " ".join(f"Neu{i}" for i in range(40))}).status_code == 200
    meta = next(b for p, b in c.rag.state.calls if p == "/api/v1/ingest")["metadata"]
    assert meta == {"source": "docs", "sync_id": INTRO, "repo": "example-org/docs", "path": "guide/intro.md", "commit": "a" * 40}


def test_failed_ingest_leaves_the_old_document(make):
    c = make()
    before = [x["id"] for x in c.rag.state.chunks]
    c.rag.state.fail_ingest = 500
    r = c.put(f"{K}/documents/{NOTE}", json={"text": "neu"})
    assert r.status_code == 502 and "kaputt" not in r.text
    assert [x["id"] for x in c.rag.state.chunks] == before
    assert not any(p.endswith("/delete") for p, _ in c.rag.state.calls)


def test_silent_ingest_does_not_delete_the_old_chunks(make):
    c = make()
    before = [x["id"] for x in c.rag.state.chunks]
    c.rag.state.ingest_noop = True
    r = c.put(f"{K}/documents/{NOTE}", json={"text": "neu"})
    assert r.status_code == 502 and "unverändert" in r.json()["detail"]
    assert [x["id"] for x in c.rag.state.chunks] == before


def test_failed_removal_is_reported_as_duplicate_state(make):
    c = make()
    c.rag.state.fail_chroma_delete = 500
    r = c.put(f"{K}/documents/{NOTE}", json={"text": "Neu genug um gespeichert zu werden."})
    assert r.status_code == 502 and "doppelt" in r.json()["detail"] and "gespeichert" in r.json()["detail"]
    assert sum(1 for x in c.rag.state.chunks if x["meta"]["sync_id"] == NOTE) > 1  # beide Fassungen sind da: die Meldung stimmt


def test_replace_validation_and_unknown_document(make):
    c = make()
    n = len(c.rag.state.calls)
    for bad in ({}, {"text": ""}, {"text": "x", "title": ""}, {"text": "x", "title": "a\nb"}, {"text": "x" * (1_048_576 + 1)}, {"text": "x", "source": "boese"}, {"text": "x", "sync_id": "y"}):
        assert c.put(f"{K}/documents/{NOTE}", json=bad).status_code == 422, str(bad)[:60]
    assert c.put(f"{K}/documents/gibts:nicht", json={"text": "x"}).status_code == 404
    assert not any(p == "/api/v1/ingest" for p, _ in c.rag.state.calls[n:])


def test_big_text_up_to_one_mib_is_accepted_for_ingest(make):
    c = make()
    assert c.post(f"{K}/ingest", json={"title": "Gross", "text": "x" * 1_048_576}).status_code == 200
    assert c.post(f"{K}/ingest", json={"title": "Zu gross", "text": "x" * 1_048_577}).status_code == 422


def test_replace_needs_fresh_login(make):
    c = make(auth_mode="oidc", oidc_issuer="https://id.test", oidc_client_id="t", oidc_client_secret="t", oidc_allowed_sub="user", public_url="http://testserver")
    assert c.put(f"{K}/documents/{NOTE}", json={"text": "x"}).status_code == 401
    assert not any(p == "/api/v1/ingest" for p, _ in c.rag.state.calls)
