import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, api, toLogin } from "../api";
import { Icon } from "../components/Icon";
import { PageHead } from "../components/PageHead";
import { DocView } from "../components/knowledge/DocView";
import { IngestForm } from "../components/knowledge/IngestForm";
import type { KnowledgeDoc, KnowledgeHit, KnowledgeProvider, KnowledgeStats } from "../types";
import { useAsync, type Async } from "../useAsync";

const de = (n: number) => n.toLocaleString("de-DE");
const score = (n: number) => n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const REMOVE_HINT = "Der Sync fügt dieses Dokument erst wieder hinzu, wenn sich die Datei im Repository ändert.";

function Chips({ s }: { s: Async<KnowledgeStats> }) {
  if (s.error) return <p className="banner" role="alert"><Icon name="alert" />Statistik nicht ladbar: {s.error}</p>;
  if (!s.data) return <p className="muted small">Lade…</p>;
  const d = s.data;
  if (!d.reachable) return <p className="banner" role="alert"><Icon name="alert" /><span>Wissensdienst nicht erreichbar: {d.reason}</span></p>;
  const chip = (label: string, v: string | number | null | undefined) => v == null ? null : <span className="chip" key={label}><span className="lbl">{label}</span>{typeof v === "number" ? de(v) : v}</span>;
  return (
    <div className="kn-chips" role="group" aria-label="Statistik">
      {chip("Chunks", d.count)}{chip("Dokumente", d.documents)}{chip("Quellen", d.sources)}{chip("Modell", d.embedding_model)}
      {d.chunk_size != null && chip("Chunkgröße / Überlappung", `${de(d.chunk_size)} / ${de(d.chunk_overlap ?? 0)}`)}
    </div>
  );
}

function Hit({ h, onOpen }: { h: KnowledgeHit; onOpen: (syncId: string, focus: string) => void }) {
  const pct = Math.max(0, Math.min(1, h.score)) * 100;
  return (
    <li className="card kn-hit">
      <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
        <b className="grow trunc mono small">{h.path ?? h.sync_id ?? "Ohne Pfad"}</b>
        {h.repo && <span className="tag">{h.repo}</span>}
        {h.source && <span className="tag">{h.source}</span>}
        <span className="kn-score" title="Ähnlichkeit"><span className="prog" aria-hidden><b style={{ width: `${pct}%` }} /></span><span className="mono small" aria-label={`Score ${score(h.score)}`}>{score(h.score)}</span></span>
      </div>
      <pre>{h.text}</pre>
      {h.sync_id && <button type="button" className="btn btn-s" style={{ alignSelf: "flex-start" }} onClick={() => onOpen(h.sync_id!, h.text)}>Dokument öffnen</button>}
      {h.url && <a className="linkish small" href={h.url} target="_blank" rel="noopener noreferrer">Im Repo öffnen</a>}
    </li>
  );
}

function Search({ provider, source, setSource, sources, onOpen }: { provider: string; source: string; setSource: (s: string) => void; sources?: string[]; onOpen: (syncId: string, focus: string) => void }) {
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState(8);
  const [state, setState] = useState<{ busy?: boolean; error?: string; hits?: KnowledgeHit[] }>({});
  const run = async (e: FormEvent) => {
    e.preventDefault();
    setState({ busy: true });
    try { setState({ hits: (await api.knowledgeSearch(provider, { query: query.trim(), top_k: topK, source: source || undefined })).results }); } catch (err) { setState({ error: (err as Error).message }); }
  };
  return (
    <section className="kn-sec" aria-label="Suche">
      <form className="row mem-bar" role="search" onSubmit={(e) => void run(e)}>
        <label className="search grow">
          <Icon name="search" size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} maxLength={500} placeholder="Was soll das Wissen dazu sagen?" aria-label="Wissen durchsuchen" />
        </label>
        {sources ? (
          <select className="field field-line" style={{ flex: "none", width: "auto" }} value={source} onChange={(e) => setSource(e.target.value)} aria-label="Quelle">
            <option value="">Alle Quellen</option>
            {sources.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        ) : (
          <input className="field field-line" style={{ flex: "none", width: 160 }} value={source} onChange={(e) => setSource(e.target.value)} placeholder="Quelle (optional)" aria-label="Quelle" maxLength={200} />
        )}
        <select className="field field-line" style={{ flex: "none", width: "auto" }} value={topK} onChange={(e) => setTopK(Number(e.target.value))} aria-label="Anzahl Treffer">
          {[3, 5, 8, 12, 20].map((n) => <option key={n} value={n}>{n} Treffer</option>)}
        </select>
        <button type="submit" className="btn btn-s btn-p" disabled={!query.trim() || state.busy}>{state.busy ? "Suche…" : "Suchen"}</button>
      </form>
      {state.error && <p className="banner" role="alert"><Icon name="alert" /><span>Suche fehlgeschlagen: {state.error}</span></p>}
      {state.hits && (state.hits.length === 0 ? <p className="panel-empty">Keine Treffer.</p> : <ul className="kn-hits">{state.hits.map((h, i) => <Hit key={i} h={h} onOpen={onOpen} />)}</ul>)}
      {!state.hits && !state.error && !state.busy && <p className="panel-empty">Die Suche arbeitet nach Bedeutung, nicht nur nach Wortlaut.</p>}
    </section>
  );
}

function SourceTable({ rows, source, setSource }: { rows: Array<{ source: string; chunks: number; documents: number; repos: string[] }>; source: string; setSource: (s: string) => void }) {
  return (
    <div className="kn-table-scroll">
      <table className="tbl">
        <thead><tr><th>Quelle</th><th>Chunks</th><th>Dokumente</th><th>Repos</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.source} className={`kn-click${r.source === source ? " on" : ""}`} onClick={() => setSource(r.source === source ? "" : r.source)}>
              <td><button type="button" className="linkish" aria-pressed={r.source === source}>{r.source}</button></td>
              <td>{de(r.chunks)}</td><td>{de(r.documents)}</td><td>{r.repos.join(", ") || "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Unavailable({ reason }: { reason: string | null }) {
  return <p className="panel-empty">Nicht verfügbar: {reason ?? "unbekannter Grund"}</p>;
}

function ConfirmDelete({ provider, doc, onClose, onDone }: { provider: string; doc: KnowledgeDoc; onClose: () => void; onDone: () => void }) {
  const modal = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = modal.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [stepUp, setStepUp] = useState(false);
  const go = async () => {
    setBusy(true); setError(undefined); setStepUp(false);
    try { await api.knowledgeDelete(provider, doc.sync_id); onDone(); } catch (e) {
      if (e instanceof ApiError && e.code === "step_up_required") setStepUp(true); else setError((e as Error).message);
    } finally { setBusy(false); }
  };
  return (
    <dialog ref={modal} className="kn-modal" aria-label="Dokument löschen" onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>
      <div className="card">
        <h2>Dokument löschen?</h2>
        <p style={{ margin: 0 }}><b>{doc.title ?? doc.path ?? doc.sync_id}</b>{" "}<span className="mono small t3">({de(doc.chunks)} Chunks)</span></p>
        <p className="hint" style={{ margin: 0 }}>{REMOVE_HINT}</p>
        <label className="col" style={{ gap: 4 }}>
          <span className="small">Zum Bestätigen die Kennung eintippen: <code>{doc.sync_id}</code></span>
          <input className="field field-line" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Kennung zur Bestätigung" autoComplete="off" spellCheck={false} />
        </label>
        {stepUp && <p className="banner" role="alert"><Icon name="lock" /><span>Das Löschen verlangt eine frische Anmeldung. <button type="button" className="linkish" onClick={() => toLogin(true)}>Erneut anmelden</button></span></p>}
        {error && <p className="banner" role="alert"><Icon name="alert" /><span>{error}</span></p>}
        <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-s" disabled={busy} onClick={onClose}>Abbrechen</button>
          <button type="button" className="btn btn-s btn-p" disabled={typed !== doc.sync_id || busy} onClick={() => void go()}>{busy ? "Lösche…" : "Endgültig löschen"}</button>
        </div>
      </div>
    </dialog>
  );
}

function Documents({ provider, source, revision, onChanged, onOpen }: { provider: string; source: string; revision: number; onChanged: () => void; onOpen: (syncId: string) => void }) {
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [doomed, setDoomed] = useState<KnowledgeDoc>();
  const docs = useAsync(() => api.knowledgeDocuments(provider, { source: source || undefined, q: q.trim() || undefined, limit: 100, offset }), [provider, source, q, revision, offset]);
  const d = docs.data;
  return (
    <section className="kn-sec" aria-label="Dokumente">
      <h2>Dokumente{d?.available ? ` (${de(d.total)})` : ""}</h2>
      {d?.available && (
        <label className="search" style={{ marginBottom: 8 }}>
          <Icon name="search" size={14} />
          <input value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} maxLength={200} placeholder="Kennung, Pfad oder Titel" aria-label="Dokumente filtern" />
        </label>
      )}
      {docs.error && <p className="banner" role="alert"><Icon name="alert" /><span>Dokumente nicht ladbar: {docs.error}</span></p>}
      {docs.loading && <p className="muted small">Lade…</p>}
      {d && !d.available && <Unavailable reason={d.reason} />}
      {d?.available && (d.items.length === 0 ? <p className="panel-empty">Keine Dokumente gefunden.</p> : (
        <div className="kn-table-scroll">
          <table className="tbl">
            <thead><tr><th>Dokument</th><th>Quelle</th><th>Chunks</th><th><span className="sr-only">Aktion</span></th></tr></thead>
            <tbody>
              {d.items.map((x) => (
                <tr key={x.sync_id} className="kn-click" onClick={() => onOpen(x.sync_id)}>
                  <td><button type="button" className="linkish mono small" style={{ textAlign: "left" }}>{x.title ?? x.path ?? x.sync_id}</button>{(x.title || x.path) && <div className="hint">{x.sync_id}</div>}</td>
                  <td>{x.source}</td><td>{de(x.chunks)}</td>
                  <td><button type="button" className="btn btn-s" onClick={(e) => { e.stopPropagation(); setDoomed(x); }} aria-label={`${x.sync_id} löschen`}><Icon name="x" size={14} />Löschen</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <nav className="row" aria-label="Dokumentseiten" style={{ gap: 8, marginTop: 8 }}>
            <button type="button" className="btn btn-s" aria-label="Vorherige Dokumentseite" disabled={docs.loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>Zurück</button>
            <span className="hint" role="status">{de(offset + 1)} bis {de(offset + d.items.length)} von {de(d.total)}</span>
            <button type="button" className="btn btn-s" aria-label="Nächste Dokumentseite" disabled={docs.loading || offset + d.items.length >= d.total} onClick={() => setOffset(offset + 100)}>Weiter</button>
          </nav>
        </div>
      ))}
      {doomed && <ConfirmDelete provider={provider} doc={doomed} onClose={() => setDoomed(undefined)} onDone={() => { setDoomed(undefined); onChanged(); }} />}
    </section>
  );
}

function SourceHead({ row, onAll }: { row: { source: string; chunks: number; documents: number; repos: string[] }; onAll: () => void }) {
  return (
    <section className="card kn-sourcehead" aria-label="Quellenansicht">
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <h2 className="grow" style={{ margin: 0 }}>Quelle {row.source}</h2>
        <span className="chip"><span className="lbl">Dokumente</span>{de(row.documents)}</span>
        <span className="chip"><span className="lbl">Chunks</span>{de(row.chunks)}</span>
        {row.repos.length > 0 && <span className="chip"><span className="lbl">Repos</span>{row.repos.join(", ")}</span>}
        <button type="button" className="btn btn-s" onClick={onAll}>Alle Quellen</button>
      </div>
    </section>
  );
}

function Knowledge({ provider }: { provider: KnowledgeProvider }) {
  const [source, setSource] = useState("");
  const [revision, setRevision] = useState(0);
  const [open, setOpen] = useState<{ syncId: string; focus?: string }>();
  const stats = useAsync(() => api.knowledgeStats(provider.id), [provider.id, revision]);
  const sources = useAsync(() => (provider.has_sources ? api.knowledgeSources(provider.id) : Promise.resolve(undefined)), [provider.id, revision]);
  const s = sources.data;
  const bump = () => setRevision((r) => r + 1);
  const sd = stats.data;
  const row = s?.available ? s.items.find((i) => i.source === source) : undefined;
  if (open) return <DocView key={open.syncId} provider={provider.id} syncId={open.syncId} focus={open.focus} chunkSize={sd?.chunk_size} overlap={sd?.chunk_overlap} onBack={() => setOpen(undefined)} onChanged={bump} />;
  return (
    <>
      <Chips s={stats} />
      <Search provider={provider.id} source={source} setSource={setSource} sources={s?.available ? s.items.map((i) => i.source) : undefined} onOpen={(syncId, focus) => setOpen({ syncId, focus })} />
      <section className="kn-sec" aria-label="Quellen">
        <h2>Quellen</h2>
        {sources.error && <p className="banner" role="alert"><Icon name="alert" /><span>Quellen nicht ladbar: {sources.error}</span></p>}
        {sources.loading && <p className="muted small">Lade…</p>}
        {!provider.has_sources && <Unavailable reason="Keine chroma_url konfiguriert, darum gibt es keine Quellenübersicht." />}
        {s && !s.available && <Unavailable reason={s.reason} />}
        {s?.available && <SourceTable rows={s.items} source={source} setSource={setSource} />}
        {s?.available && s.truncated && <p className="hint" role="status">Nur die ersten {de(s.scanned_chunks)} Chunks wurden gezählt, die Übersicht ist unvollständig.</p>}
      </section>
      {row && <SourceHead row={row} onAll={() => setSource("")} />}
      <Documents key={JSON.stringify([source, revision])} provider={provider.id} source={source} revision={revision} onChanged={bump} onOpen={(syncId) => setOpen({ syncId })} />
      <IngestForm provider={provider.id} sources={s?.available ? s.items.map((i) => i.source) : undefined} chunkSize={sd?.chunk_size} overlap={sd?.chunk_overlap} onDone={bump} />
    </>
  );
}

/** Wissen: ein selbst gehostetes RAG-System ansehen und pflegen (Statistik, Suche, Quellen, Dokumente mit Detailansicht und Bearbeiten, Einspeisen, Löschen). Die Anbieter stehen in der Konfiguration des BFF. */
export function KnowledgePage() {
  const list = useAsync(() => api.knowledgeProviders(), []);
  const [chosen, setChosen] = useState<string>();
  const providers = list.data?.providers ?? [];
  const provider = providers.find((p) => p.id === chosen) ?? providers[0];
  return (
    <main className="page">
      <PageHead title="Wissen" sub={provider?.label}>
        {providers.length > 1 && (
          <label className="row" style={{ gap: 6 }}>
            <span className="lbl">Anbieter</span>
            <select className="field field-line" value={provider?.id} onChange={(e) => setChosen(e.target.value)} aria-label="Anbieter">
              {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
        )}
      </PageHead>
      {list.error && <p className="banner" role="alert"><Icon name="alert" />Wissen nicht ladbar: {list.error}</p>}
      {list.loading && <p className="muted">Lade…</p>}
      {list.data?.config_error && <p className="banner" role="alert"><Icon name="alert" />Die Wissens-Konfiguration ist fehlerhaft: {list.data.config_error}</p>}
      {list.data && providers.length === 0 && !list.data.config_error && (
        <div className="empty">
          <h2>Kein Wissens-Anbieter eingerichtet</h2>
          <p className="muted">Anbieter stehen in der Datei, auf die <code>HERMES_WEBUI_KNOWLEDGE_FILE</code> zeigt (Vorlage: <code>backend/knowledge.example.json</code>).</p>
        </div>
      )}
      {provider && <Knowledge key={provider.id} provider={provider} />}
    </main>
  );
}
