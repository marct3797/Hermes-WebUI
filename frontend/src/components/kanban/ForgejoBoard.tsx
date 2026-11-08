import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../Icon";
import { Markdown } from "../Markdown";
import { forgejoApi, type FjInstance, type FjIssue, type FjIssueDetail } from "../../forgejoApi";
import type { Card, Column } from "../../kanbanApi";
import { poll } from "../../poll";
import { t as tr } from "../../i18n";
import { BoardColumns } from "./Board";
import { Banner } from "./Dialogs";

const POLL_MS = 30_000;
const toCard = (i: FjIssue): Card => ({
  id: String(i.number), title: `#${i.number} ${i.title}`, status: i.column, assignee: i.assignee, priority: 0, created_at: null, completed_at: null,
  age_seconds: i.created_at ? Math.max(0, (Date.now() - Date.parse(i.created_at)) / 1000) : null, comment_count: i.comments, link_counts: { parents: 0, children: 0 },
  warnings: { count: 0, highest_severity: null }, block_kind: null, snippet: i.snippet,
});

/** Forgejo-Issues als eigenes Board: Spalten aus der Konfiguration, Verschieben setzt Label und Status am Issue (nur Forgejo, nie das Hermes-Kanban). */
export function ForgejoBoard({ instances, configError }: { instances: FjInstance[]; configError: string | null }) {
  const [instId, setInstId] = useState(instances[0]?.id ?? "");
  const inst = instances.find((i) => i.id === instId) ?? instances[0];
  const [repo, setRepo] = useState(inst?.repos[0] ?? "");
  useEffect(() => { if (inst && !inst.repos.includes(repo)) setRepo(inst.repos[0]); }, [inst, repo]);
  const [issues, setIssues] = useState<FjIssue[]>();
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string>();
  const [moveError, setMoveError] = useState<unknown>();
  const [query, setQuery] = useState("");
  const [dragId, setDragId] = useState<string>();
  const [open, setOpen] = useState<number>();
  const [creating, setCreating] = useState(false);
  const seq = useRef(0);
  const alive = useRef(true);

  const load = useCallback(async () => {
    if (!inst || !repo) return;
    const n = ++seq.current;
    try {
      const r = await forgejoApi.issues(inst.id, repo);
      if (!alive.current || n !== seq.current) return;
      setIssues(r.issues); setTruncated(r.truncated); setError(undefined);
    } catch (e) {
      if (alive.current && n === seq.current) setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, [inst, repo]);
  useEffect(() => {
    alive.current = true; setIssues(undefined); setOpen(undefined); setError(undefined);
    load().catch(() => undefined);
    const stop = poll(load, POLL_MS);
    return () => { alive.current = false; stop(); };
  }, [load]);

  const q = query.trim().toLowerCase();
  const columns: Column[] = useMemo(() => (inst?.columns ?? []).map((name) => ({
    name, tasks: (issues ?? []).filter((i) => i.column === name && (!q || `${i.title} ${i.snippet} #${i.number}`.toLowerCase().includes(q))).map(toCard),
  })), [inst, issues, q]);
  const totals = useMemo(() => Object.fromEntries((inst?.columns ?? []).map((c) => [c, (issues ?? []).filter((i) => i.column === c).length])), [inst, issues]);

  const move = async (id: string, to: string) => {
    const prev = issues;
    const it = prev?.find((i) => String(i.number) === id);
    if (!prev || !it || it.column === to || !inst) return;
    setMoveError(undefined);
    setIssues(prev.map((i) => i === it ? { ...i, column: to, state: to === "closed" ? "closed" : "open" } : i));
    try { await forgejoApi.patch(inst.id, repo, it.number, { column: to }); await load().catch(() => undefined); } catch (e) { setIssues(prev); setMoveError(e); }
  };

  if (!inst) return <p className="panel-empty">{configError ?? tr("Keine Forgejo-Instanz konfiguriert.")}</p>;
  return (
    <>
      <div className="kb-bar row" style={{ gap: 8, flexWrap: "wrap" }}>
        {instances.length > 1 && <label className="row" style={{ gap: 6 }}>{tr("Instanz")}
          <select className="field field-line" aria-label={tr("Instanz")} value={inst.id} onChange={(e) => setInstId(e.target.value)}>{instances.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}</select></label>}
        <label className="row" style={{ gap: 6 }}>{tr("Repo")}
          <select className="field field-line" aria-label={tr("Repo")} value={repo} onChange={(e) => setRepo(e.target.value)}>{inst.repos.map((r) => <option key={r} value={r}>{r}</option>)}</select></label>
        <button type="button" className="btn btn-s btn-p" disabled={!issues} onClick={() => setCreating(true)}><Icon name="plus" size={14} />{tr("Neues Issue")}</button>
        <input className="field field-line grow" type="search" aria-label={tr("Issues suchen")} placeholder={tr("Suche in Titel, Text und Nummer")} value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="button" className="btn btn-s btn-g" onClick={() => void load().catch(() => undefined)}><Icon name="refresh" size={14} />{tr("Neu laden")}</button>
      </div>
      {configError && <Banner error={configError} />}
      {!inst.token_set && <Banner error={tr("Der Forgejo-Token fehlt auf dem Server (Umgebungsvariable aus der Konfiguration).")} />}
      {error && <Banner error={tr("Issues nicht ladbar: {error}", { error })} />}
      <Banner error={moveError} />
      {truncated && <p className="hint">{tr("Nur die neuesten Issues sind geladen.")}</p>}
      {!issues && !error && <p role="status">{tr("Issues werden geladen…")}</p>}
      {issues && issues.length === 0 && <p className="panel-empty" role="status">{tr("Keine Issues in diesem Repo.")}</p>}
      <div className={`kb-layout${open ? " has-panel" : ""}`}>
        {issues && <BoardColumns columns={columns} total={totals} filtered={!!q} selected={open ? String(open) : undefined} dragId={dragId} onOpen={(id) => setOpen(Number(id))} onMove={(id, to) => void move(id, to)} onDragId={setDragId} />}
        {open && <IssuePanel key={`${inst.id}:${repo}:${open}`} inst={inst} repo={repo} number={open} onClose={() => setOpen(undefined)} onChanged={() => void load().catch(() => undefined)} />}
      </div>
      {creating && <NewIssueForm onCancel={() => setCreating(false)} onCreate={async (b) => {
        const r = await forgejoApi.create(inst.id, repo, b);
        setCreating(false); await load().catch(() => undefined); setOpen(r.number);
      }} />}
    </>
  );
}

function NewIssueForm({ onCancel, onCreate }: { onCancel: () => void; onCreate: (b: { title: string; body: string; assignee: string }) => Promise<void> }) {
  const [f, setF] = useState({ title: "", body: "", assignee: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  return (
    <form className="card" aria-label={tr("Neues Issue")} onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(undefined); try { await onCreate({ ...f, title: f.title.trim(), assignee: f.assignee.trim() }); } catch (x) { setError(x); } finally { setBusy(false); } }}>
      <h2>{tr("Neues Issue")}</h2>
      <label className="col kb-lab">{tr("Titel *")}<input className="field field-line" autoFocus required maxLength={255} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
      <label className="col kb-lab">{tr("Text (Markdown)")}<textarea className="field" rows={5} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
      <label className="col kb-lab">{tr("Zugewiesen an")}<input className="field field-line" maxLength={100} value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })} /></label>
      <Banner error={error} />
      <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="btn btn-s" disabled={busy} onClick={onCancel}>{tr("Abbrechen")}</button>
        <button type="submit" className="btn btn-s btn-p" disabled={busy || !f.title.trim()}>{tr("Issue anlegen")}</button>
      </div>
    </form>
  );
}

function IssuePanel({ inst, repo, number, onClose, onChanged }: { inst: FjInstance; repo: string; number: number; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<FjIssueDetail>();
  const [loadError, setLoadError] = useState<string>();
  const [form, setForm] = useState({ title: "", body: "", assignee: "" });
  const [comment, setComment] = useState("");
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async (reset: boolean) => {
    try {
      const r = await forgejoApi.issue(inst.id, repo, number);
      setD(r); setLoadError(undefined);
      if (reset) setForm({ title: r.title, body: r.body, assignee: r.assignee ?? "" });
    } catch (e) { setLoadError(e instanceof Error ? e.message : String(e)); }
  }, [inst.id, repo, number]);
  useEffect(() => { void reload(true); }, [reload]);
  const act = async (fn: () => Promise<unknown>, reset = false) => {
    setBusy(true); setError(undefined);
    try { await fn(); await reload(reset); onChanged(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const head = <header className="kb-phead"><div className="grow"><h2>{tr("Issue")} #{number}</h2></div>
    <button type="button" className="btn btn-s btn-i" aria-label={tr("Detail schließen")} onClick={onClose}><Icon name="x" size={14} /></button></header>;
  if (!d) return <aside className="kb-panel" aria-label={tr("Issue")}>{head}{loadError ? <Banner error={tr("Issues nicht ladbar: {error}", { error: loadError })} /> : <p role="status">{tr("Issues werden geladen…")}</p>}</aside>;
  const patch: Record<string, string> = {};
  if (form.title.trim() !== d.title) patch.title = form.title.trim();
  if (form.body !== d.body) patch.body = form.body;
  if (form.assignee.trim() !== (d.assignee ?? "")) patch.assignee = form.assignee.trim();
  return (
    <aside className="kb-panel" aria-label={tr("Issue")}>
      {head}
      <p className="mono small t3">{d.state === "closed" ? tr("Geschlossen") : tr("Offen")} · {d.author}{d.url && <> · <a href={d.url} target="_blank" rel="noopener noreferrer">{tr("In Forgejo öffnen")}</a></>}</p>
      {d.labels.length > 0 && <p className="row" style={{ gap: 4, flexWrap: "wrap" }}>{d.labels.map((l) => <span key={l.name} className="chip chip-s">{l.name}</span>)}</p>}
      <label className="col kb-lab">{tr("Titel *")}<input className="field field-line" maxLength={255} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
      <label className="col kb-lab">{tr("Text (Markdown)")}<textarea className="field" rows={6} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></label>
      <label className="col kb-lab">{tr("Zugewiesen an")}<input className="field field-line" maxLength={100} value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })} /></label>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-s btn-p" disabled={busy || !Object.keys(patch).length || !form.title.trim()} onClick={() => void act(() => forgejoApi.patch(inst.id, repo, number, patch), true)}>{tr("Speichern")}</button>
        <button type="button" className="btn btn-s" disabled={busy} onClick={() => void act(() => forgejoApi.patch(inst.id, repo, number, { column: d.state === "closed" ? "open" : "closed" }))}>{d.state === "closed" ? tr("Wieder öffnen") : tr("Schließen")}</button>
      </div>
      <Banner error={error} />
      <h3>{tr("Kommentare")} ({d.comment_list.length})</h3>
      <ul className="col" style={{ gap: 8, listStyle: "none", padding: 0 }}>{d.comment_list.map((c, i) => <li key={c.id ?? i}><span className="mono small t3">{c.author}</span><Markdown text={c.body} /></li>)}</ul>
      <textarea className="field" rows={3} aria-label={tr("Kommentar")} value={comment} onChange={(e) => setComment(e.target.value)} />
      <button type="button" className="btn btn-s" disabled={busy || !comment.trim()} onClick={() => void act(async () => { await forgejoApi.comment(inst.id, repo, number, comment.trim()); setComment(""); })}>{tr("Kommentar senden")}</button>
    </aside>
  );
}
