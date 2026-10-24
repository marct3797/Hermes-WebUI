"""Wissens-Anbieter: eine Schnittstelle für selbst gehostete RAG-Dienste (erster Typ: `hermes-rag`).

Gemeinsame Formen (siehe README, Abschnitt Wissen):
    Treffer   {text, score, source, repo, path, commit, sync_id, url|None}
    Quelle    {source, chunks, documents, repos[]}
    Dokument  {sync_id, source, repo, path, commit, chunks, title}

Neuer Anbieter: Klasse von `KnowledgeProvider` ableiten und in `PROVIDER_TYPES` eintragen.
"""
from __future__ import annotations

import asyncio
import json
import re
import time
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

import httpx

from .adapters import UpstreamError

ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
PAGE = 1000  # Chunks je Chroma-Anfrage
MAX_SCAN = 50_000  # darüber bricht der Scan ab (`truncated`)
NO_ID = "(ohne Kennung)"
NO_SOURCE = "(ohne Quelle)"
TEXT_MAX = 1200
DOC_CHUNKS = 500  # Chunks je Dokument, die die Detailansicht und das Ersetzen höchstens anfassen
INGEST_MAX = 1_048_576  # Zeichen je Dokument (1 MiB)
MIN_OVERLAP = 20  # kürzere Übereinstimmungen am Chunk-Rand gelten nicht als Überlappung


@dataclass(frozen=True)
class KnowledgeCfg:
    id: str
    type: str
    label: str
    base_url: str
    chroma_url: str = ""
    collection: str = ""
    link_template: str = ""


def _url(pid: str, key: str, v: Any) -> str:
    u = str(v or "").rstrip("/")
    parts = urlsplit(u)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError(f"{pid}: {key} muss mit http:// oder https:// beginnen")
    if parts.username or parts.password:
        raise ValueError(f"{pid}: {key} darf keine Zugangsdaten enthalten")
    return u


def parse_knowledge_config(raw: Any) -> dict[str, KnowledgeCfg]:
    if not isinstance(raw, dict) or not isinstance(raw.get("providers"), list):
        raise ValueError('erwartet {"providers": [...]}')
    out: dict[str, KnowledgeCfg] = {}
    for p in raw["providers"]:
        if not isinstance(p, dict):
            raise ValueError("Eintrag ist kein Objekt")
        pid = str(p.get("id", ""))
        if not ID_RE.match(pid):
            raise ValueError(f"ungültige id {pid!r}")
        if pid in out:
            raise ValueError(f"id {pid!r} doppelt")
        ptype = str(p.get("type", ""))
        if ptype not in PROVIDER_TYPES:
            raise ValueError(f"unbekannter Typ {ptype!r} (bekannt: {', '.join(sorted(PROVIDER_TYPES))})")
        tpl = str(p.get("link_template") or "")
        if tpl and re.search(r"[{}]", re.sub(r"\{(repo|commit|path)\}", "", tpl)):
            raise ValueError(f"{pid}: link_template darf nur {{repo}}, {{commit}}, {{path}} enthalten")
        out[pid] = KnowledgeCfg(pid, ptype, str(p.get("label") or pid), _url(pid, "base_url", p.get("base_url")),
                                _url(pid, "chroma_url", p["chroma_url"]) if p.get("chroma_url") else "", str(p.get("collection") or ""), tpl)
    return out


class KnowledgeRegistry:
    """`knowledge.json` (siehe knowledge.example.json), bei Änderung ohne Neustart neu gelesen. Fehlt die Datei, gibt es keine Anbieter."""

    def __init__(self, path: Path | None):
        self.path = path
        self.error: str | None = None
        self._mtime: float | None = None
        self._providers: dict[str, KnowledgeCfg] = {}

    def providers(self) -> dict[str, KnowledgeCfg]:
        if self.path is None:
            return {}
        try:
            mtime = self.path.stat().st_mtime
        except FileNotFoundError:
            self._providers, self._mtime, self.error = {}, None, None
            return self._providers
        if mtime != self._mtime:
            self._mtime = mtime
            try:
                self._providers = parse_knowledge_config(json.loads(self.path.read_text("utf-8")))
                self.error = None
            except (ValueError, OSError) as e:
                self.error = f"knowledge.json: {e}"  # die letzte gültige Fassung bleibt
        return self._providers


# --- Normalisierung ----------------------------------------------------------------------------------
def _s(v: Any) -> str | None:
    return v.strip() if isinstance(v, str) and v.strip() else None


def build_url(template: str, meta: Mapping[str, Any]) -> str | None:
    """Link ins Repo. Nur wenn alle Platzhalter belegt sind; jedes Teilstück wird kodiert (Schrägstriche bleiben Trenner)."""
    if not template:
        return None
    vals: dict[str, str] = {}
    for name in set(re.findall(r"\{(\w+)\}", template)):
        v = _s(meta.get(name))
        parts = v.split("/") if v else []
        if not v or ".." in parts:
            return None
        vals[name] = "/".join(quote(p, safe="") for p in parts)
    url = re.sub(r"\{(\w+)\}", lambda m: vals[m.group(1)], template)
    return url if url.startswith(("https://", "http://")) else None


def norm_hit(r: Any, template: str) -> dict[str, Any] | None:
    if not isinstance(r, dict) or not isinstance(r.get("content"), str):
        return None
    meta = r["metadata"] if isinstance(r.get("metadata"), dict) else {}
    score = r.get("score")
    return {"text": r["content"][:TEXT_MAX], "score": float(score) if isinstance(score, (int, float)) and not isinstance(score, bool) else 0.0,
            **{k: _s(meta.get(k)) for k in ("source", "repo", "path", "commit", "sync_id")}, "url": build_url(template, meta)}


def slugify(title: str) -> str:
    t = title.lower().replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss")
    return re.sub(r"[^a-z0-9]+", "-", unicodedata.normalize("NFKD", t).encode("ascii", "ignore").decode()).strip("-")[:100]


def join_chunks(texts: list[str]) -> str:
    """Chunks zum Volltext zusammensetzen. Der Dienst schneidet mit Überlappung: der Anfang eines Chunks wiederholt das Ende des vorigen und wird nur einmal übernommen.
    shortcut: Überlappung wird am Text erkannt (mind. MIN_OVERLAP Zeichen), nicht an Token-Grenzen; ohne Treffer trennt eine Leerzeile."""
    out = ""
    for t in texts:
        if not out:
            out = t
            continue
        head, tail, cut = t[:MIN_OVERLAP], out[-2000:], 0
        i = tail.find(head) if len(head) == MIN_OVERLAP else -1
        while i != -1:
            if t.startswith(tail[i:]):
                cut = len(tail) - i
                break
            i = tail.find(head, i + 1)
        out = out + t[cut:] if cut else f"{out}\n\n{t}"
    return out


def aggregate(metadatas: list[Any]) -> tuple[dict[str, dict[str, Any]], int]:
    """Chunks → Dokumente je `sync_id`. Metadaten dürfen fehlen oder `null` sein."""
    docs: dict[str, dict[str, Any]] = {}
    for m in metadatas:
        m = m if isinstance(m, dict) else {}
        sid = _s(m.get("sync_id")) or NO_ID
        d = docs.setdefault(sid, {"sync_id": sid, "source": _s(m.get("source")) or NO_SOURCE, "repo": _s(m.get("repo")), "path": _s(m.get("path")),
                                  "commit": _s(m.get("commit")), "chunks": 0, "title": _s(m.get("title"))})
        d["chunks"] += 1
    return docs, len(metadatas)


def summarize(docs: Mapping[str, dict[str, Any]]) -> list[dict[str, Any]]:
    by: dict[str, dict[str, Any]] = {}
    for d in docs.values():
        s = by.setdefault(d["source"], {"source": d["source"], "chunks": 0, "documents": 0, "repos": set()})
        s["chunks"] += d["chunks"]
        s["documents"] += 1
        if d["repo"]:
            s["repos"].add(d["repo"])
    return sorted(({**s, "repos": sorted(s["repos"])} for s in by.values()), key=lambda s: (-s["chunks"], s["source"]))


# --- Anbieter ----------------------------------------------------------------------------------------
class KnowledgeProvider:
    type = ""

    def __init__(self, cfg: KnowledgeCfg, http: httpx.AsyncClient, cache: dict[str, Any], ttl_s: float = 300, clock=time.monotonic):
        self.cfg, self._http, self._cache, self._ttl, self._clock = cfg, http, cache, ttl_s, clock
        state = cache.get(cfg.id)
        if state is None or state["cfg"] != cfg:
            state = {"cfg": cfg, "scan": None, "scan_lock": asyncio.Lock(), "write_lock": asyncio.Lock()}
            cache[cfg.id] = state
        self._state = state

    def public(self) -> dict[str, Any]:
        return {"id": self.cfg.id, "label": self.cfg.label, "type": self.type, "has_sources": bool(self.cfg.chroma_url)}

    def drop_cache(self) -> None:
        self._state["scan"] = None

    async def stats(self) -> dict[str, Any]: raise NotImplementedError
    async def sources(self) -> dict[str, Any]: raise NotImplementedError
    async def documents(self, source: str | None, q: str | None, limit: int, offset: int) -> dict[str, Any]: raise NotImplementedError
    async def search(self, query: str, top_k: int, source: str | None) -> list[dict[str, Any]]: raise NotImplementedError
    async def ingest(self, title: str, text: str, source: str) -> dict[str, Any]: raise NotImplementedError
    async def delete(self, sync_id: str) -> dict[str, Any]: raise NotImplementedError
    async def document(self, sync_id: str) -> dict[str, Any]: raise NotImplementedError
    async def replace(self, sync_id: str, title: str | None, text: str) -> dict[str, Any]: raise NotImplementedError


class HermesRagProvider(KnowledgeProvider):
    """Hermes-RAG: eigene API für Statistik, Suche, Einspeisen und Löschen; die Quellenliste kommt (nur lesend) aus der Chroma-Datenbank dahinter."""

    type = "hermes-rag"

    async def _call(self, method: str, base: str, path: str, what: str, timeout: float = 10.0, **kw: Any) -> Any:
        try:
            r = await self._http.request(method, f"{base}{path}", headers={"Accept": "application/json"}, timeout=timeout, follow_redirects=False, **kw)
        except httpx.TimeoutException as e:
            raise UpstreamError(504, f"{what} antwortet nicht rechtzeitig") from e
        except httpx.HTTPError as e:
            raise UpstreamError(502, f"{what} nicht erreichbar") from e
        if r.status_code >= 300:  # Weiterleitungen werden nicht verfolgt und gelten als Fehler
            raise UpstreamError(502, f"{what} antwortete mit Fehler {r.status_code}")  # nie der Antworttext: er könnte Interna enthalten
        try:
            return r.json()
        except ValueError as e:
            raise UpstreamError(502, f"{what} lieferte kein JSON") from e

    async def _rag(self, method: str, path: str, **kw: Any) -> Any:
        return await self._call(method, self.cfg.base_url, path, "Wissensdienst", **kw)

    async def stats(self) -> dict[str, Any]:
        s = await self._rag("GET", "/api/v1/stats")
        if not isinstance(s, dict):
            raise UpstreamError(502, "Wissensdienst lieferte eine unbekannte Statistik")
        out: dict[str, Any] = {"reachable": True, **{k: s.get(k) for k in ("collection", "count", "embedding_model", "chunk_size", "chunk_overlap")}, "documents": None, "sources": None}
        if self.cfg.chroma_url:
            try:
                scan = await self._scan()
                out["documents"], out["sources"] = len(scan["docs"]), len(summarize(scan["docs"]))
            except UpstreamError:
                pass  # die Zähler bleiben leer; die Quellenansicht nennt den Grund
        return out

    async def _collection_name(self) -> str | None:
        s = await self._rag("GET", "/api/v1/stats")
        return s.get("collection") if isinstance(s, dict) else None

    async def _collection_id(self) -> str:
        name = self.cfg.collection or await self._collection_name()
        cols = await self._call("GET", self.cfg.chroma_url, "/api/v1/collections", "Chroma")
        cid = next((x.get("id") for x in cols if isinstance(x, dict) and x.get("name") == name), None) if isinstance(cols, list) else None
        if not isinstance(cid, str) or not re.fullmatch(r"[A-Za-z0-9-]{1,64}", cid):
            raise UpstreamError(502, "Sammlung in Chroma nicht gefunden")
        return cid

    async def _scan(self, fresh: bool = False) -> dict[str, Any]:
        async with self._state["scan_lock"]:
            return await self._scan_locked(fresh)

    async def _scan_locked(self, fresh: bool) -> dict[str, Any]:
        hit = self._state["scan"]
        if hit and not fresh and self._clock() - hit["at"] < self._ttl:
            return hit
        c = self.cfg.chroma_url
        cid = await self._collection_id()
        docs: dict[str, dict[str, Any]] = {}
        n = 0
        truncated = False
        while True:
            page = await self._call("POST", c, f"/api/v1/collections/{cid}/get", "Chroma", timeout=30.0, json={"include": ["metadatas"], "limit": min(PAGE, MAX_SCAN - n), "offset": n})
            rows = page.get("metadatas") if isinstance(page, dict) else None
            if not isinstance(rows, list):
                raise UpstreamError(502, "Chroma lieferte eine unbekannte Antwort")
            rows = rows[:MAX_SCAN - n]
            batch, count = aggregate(rows)
            for sid, doc in batch.items():
                if sid in docs:
                    docs[sid]["chunks"] += doc["chunks"]
                else:
                    docs[sid] = doc
            n += count
            if n >= MAX_SCAN:
                truncated = True
                break
            if len(rows) < PAGE:
                break
        scan = {"at": self._clock(), "docs": docs, "chunks": n, "truncated": truncated}
        self._state["scan"] = scan
        return scan

    async def sources(self) -> dict[str, Any]:
        if not self.cfg.chroma_url:
            return {"available": False, "reason": "Keine chroma_url konfiguriert: ohne sie gibt es keine Quellenübersicht.", "items": [], "scanned_chunks": 0, "truncated": False, "cache_age_s": 0}
        s = await self._scan()
        return {"available": True, "reason": None, "items": summarize(s["docs"]), "scanned_chunks": s["chunks"], "truncated": s["truncated"], "cache_age_s": int(self._clock() - s["at"])}

    async def documents(self, source: str | None, q: str | None, limit: int, offset: int) -> dict[str, Any]:
        if not self.cfg.chroma_url:
            return {"available": False, "reason": "Keine chroma_url konfiguriert: ohne sie gibt es keine Dokumentübersicht.", "items": [], "total": 0}
        needle = (q or "").lower()
        rows = [d for d in (await self._scan())["docs"].values()
                if (not source or d["source"] == source) and (not needle or any(needle in (d[k] or "").lower() for k in ("sync_id", "path", "title")))]
        rows.sort(key=lambda d: d["sync_id"])
        return {"available": True, "reason": None, "items": rows[offset:offset + limit], "total": len(rows)}

    async def search(self, query: str, top_k: int, source: str | None) -> list[dict[str, Any]]:
        payload = await self._rag("POST", "/api/v1/query", json={"query": query, "top_k": top_k, "source": source})
        rows = payload.get("results") if isinstance(payload, dict) else None
        if not isinstance(rows, list):
            raise UpstreamError(502, "Wissensdienst lieferte eine unbekannte Trefferliste")
        return [h for h in (norm_hit(r, self.cfg.link_template) for r in rows) if h]

    async def ingest(self, title: str, text: str, source: str) -> dict[str, Any]:
        slug = slugify(title)
        # shortcut: Sperre gilt je BFF-Prozess; mehrere Worker brauchen atomare Eindeutigkeit im RAG-Dienst.
        async with self._state["write_lock"]:
            return await self._ingest_locked(slug, title, text, source)

    async def _ingest_locked(self, slug: str, title: str, text: str, source: str) -> dict[str, Any]:
        if not slug:
            raise UpstreamError(422, "Aus dem Titel lässt sich keine Kennung bilden (bitte Buchstaben oder Ziffern verwenden)")
        meta = {"source": source, "sync_id": f"manual:{slug}", "title": title}
        if self.cfg.chroma_url:
            scan = await self._scan(fresh=True)
            if scan["truncated"]:
                raise UpstreamError(409, "Die Dokumentübersicht ist unvollständig. Die Kennung kann nicht sicher auf Duplikate geprüft werden.")
            if meta["sync_id"] in scan["docs"]:
                raise UpstreamError(409, f"Es gibt schon ein Dokument mit der Kennung {meta['sync_id']}. Bitte einen anderen Titel wählen oder das alte Dokument zuerst löschen.")
        try:
            await self._rag("POST", "/api/v1/ingest", timeout=120.0, json={"text": text, "metadata": meta})
        finally:
            self.drop_cache()
        return {"ok": True, **meta}

    async def delete(self, sync_id: str) -> dict[str, Any]:
        try:
            r = await self._rag("POST", "/api/v1/delete", json={"where": {"sync_id": sync_id}})
        finally:
            self.drop_cache()
        n = next((r[k] for k in ("deleted", "count", "deleted_count") if isinstance(r, dict) and isinstance(r.get(k), int) and not isinstance(r.get(k), bool)), None)
        return {"ok": True, **({"deleted": n} if n is not None else {})}

    async def _chunks(self, sync_id: str) -> tuple[list[dict[str, Any]], bool]:
        """Chunks eines Dokuments aus Chroma in Speicherreihenfolge: [{id, text, meta}], abgeschnitten?"""
        if not self.cfg.chroma_url:
            raise UpstreamError(409, "Ohne chroma_url gibt es keine Dokumentansicht und kein Bearbeiten.")
        cid = await self._collection_id()
        page = await self._call("POST", self.cfg.chroma_url, f"/api/v1/collections/{cid}/get", "Chroma", timeout=30.0,
                                json={"where": {"sync_id": sync_id}, "include": ["documents", "metadatas"], "limit": DOC_CHUNKS, "offset": 0})
        ids, docs, metas = (page.get(k) if isinstance(page, dict) else None for k in ("ids", "documents", "metadatas"))
        if not (isinstance(ids, list) and isinstance(docs, list) and len(ids) == len(docs)):
            raise UpstreamError(502, "Chroma lieferte eine unbekannte Antwort")
        metas = metas if isinstance(metas, list) and len(metas) == len(ids) else [None] * len(ids)
        rows = [{"id": i, "text": d if isinstance(d, str) else "", "meta": m if isinstance(m, dict) else {}} for i, d, m in zip(ids, docs, metas) if isinstance(i, str)]
        return rows, len(rows) >= DOC_CHUNKS

    async def document(self, sync_id: str) -> dict[str, Any]:
        rows, truncated = await self._chunks(sync_id)
        if not rows:
            raise UpstreamError(404, "Dokument nicht gefunden")
        d = next(iter(aggregate([r["meta"] for r in rows])[0].values()))
        return {**{k: d[k] for k in ("sync_id", "source", "repo", "path", "commit", "title")}, "sync_id": sync_id, "chunks": len(rows), "truncated": truncated,
                "editable": not truncated, "text": join_chunks([r["text"] for r in rows]), "parts": [{"index": n, "text": r["text"]} for n, r in enumerate(rows)]}

    async def replace(self, sync_id: str, title: str | None, text: str) -> dict[str, Any]:
        """Dokument ersetzen: neue Fassung unter derselben `sync_id` einspeisen, erst danach genau die alten Chunks (nach Chroma-ID) entfernen.
        Schlägt das Einspeisen fehl, bleibt das Alte unberührt. Schlägt nur das Entfernen fehl, existieren beide Fassungen (Fehlermeldung nennt das).
        shortcut: nicht atomar über beide Dienste, kein Rollback der neuen Chunks nach einem Fehler beim Entfernen; die Sperre gilt je BFF-Prozess."""
        async with self._state["write_lock"]:
            return await self._replace_locked(sync_id, title, text)

    async def _replace_locked(self, sync_id: str, title: str | None, text: str) -> dict[str, Any]:
        old, truncated = await self._chunks(sync_id)
        if not old:
            raise UpstreamError(404, "Dokument nicht gefunden")
        if truncated:
            raise UpstreamError(409, f"Das Dokument hat mindestens {DOC_CHUNKS} Chunks und lässt sich nicht sicher ersetzen.")
        d = next(iter(aggregate([old[0]["meta"]])[0].values()))
        meta = {k: v for k, v in {"source": d["source"], "sync_id": sync_id, "title": title or d["title"], "repo": d["repo"], "path": d["path"], "commit": d["commit"]}.items() if v}
        old_ids = {r["id"] for r in old}
        try:
            await self._rag("POST", "/api/v1/ingest", timeout=120.0, json={"text": text, "metadata": meta})
        finally:
            self.drop_cache()
        now, _ = await self._chunks(sync_id)
        fresh = [r["id"] for r in now if r["id"] not in old_ids]
        if not fresh:
            raise UpstreamError(502, "Die neue Fassung ist nicht in der Datenbank angekommen. Das alte Dokument bleibt unverändert.")
        try:
            await self._call("POST", self.cfg.chroma_url, f"/api/v1/collections/{await self._collection_id()}/delete", "Chroma", timeout=30.0, json={"ids": sorted(old_ids)})
        except UpstreamError as e:
            raise UpstreamError(502, f"Die neue Fassung ist gespeichert, aber die {len(old_ids)} alten Chunks ließen sich nicht entfernen ({e.detail}). Das Dokument ist vorübergehend doppelt vorhanden.") from e
        finally:
            self.drop_cache()
        return {"ok": True, "sync_id": sync_id, "chunks": len(fresh), "removed": len(old_ids)}


PROVIDER_TYPES: dict[str, type[KnowledgeProvider]] = {"hermes-rag": HermesRagProvider}
