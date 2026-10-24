import { useCallback, useEffect, useState } from "react";
import { Icon } from "../Icon";
import { Markdown } from "../Markdown";
import { fmtDate, fmtTime } from "../../format";
import { assertBulk, kanbanApi, type Card, type TaskDetail } from "../../kanbanApi";
import { ArchiveDialog, Banner } from "./Dialogs";
import { columnLabel } from "./Board";

const LOG_STEP = 20_000;
const ts = (s: number | null) => (s === null ? "" : `${fmtDate(s * 1000)} ${fmtTime(s * 1000)}`);

export function TaskPanel({ host, board, id, columns, assignees, allTasks, onClose, onChanged }: {
  host: string; board?: string; id: string; columns: string[]; assignees: string[]; allTasks: Card[]; onClose: () => void; onChanged: () => void;
}) {
  const [d, setD] = useState<TaskDetail>();
  const [loadError, setLoadError] = useState<string>();
  const [form, setForm] = useState({ title: "", body: "", priority: 0, status: "", block_reason: "", result: "", summary: "" });
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<unknown>();
  const [note, setNote] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState("");
  const [who, setWho] = useState("");
  const [reclaimFirst, setReclaimFirst] = useState(false);
  const [linkWith, setLinkWith] = useState({ other: "", role: "parent" });
  const [archive, setArchive] = useState(false);
  const [log, setLog] = useState<{ data?: { content: string; truncated: boolean; exists: boolean }; tail: number; error?: string; loading: boolean }>();

  const reload = useCallback(async (resetForm: boolean) => {
    try {
      const r = await kanbanApi.task(host, board, id);
      setD(r); setLoadError(undefined);
      if (resetForm) {
        setForm({ title: r.task.title, body: r.task.body, priority: r.task.priority, status: r.task.status, block_reason: "", result: r.task.result ?? "", summary: r.task.summary ?? "" });
        setWho(r.task.assignee ?? "");
      }
    } catch (e) { setLoadError(e instanceof Error ? e.message : String(e)); }
  }, [host, board, id]);
  useEffect(() => { setD(undefined); setLog(undefined); setNote(undefined); setError(undefined); void reload(true); }, [reload]);

  // Jede Schreibaktion: Fehler bleiben sichtbar, Erfolg lädt Detail und Board neu.
  const act = async (fn: () => Promise<unknown>, done: string, resetForm = false) => {
    setBusy(true); setError(undefined); setNote(undefined);
    try { await fn(); setNote(done); await reload(resetForm); onChanged(); return true; } catch (e) { setError(e); return false; } finally { setBusy(false); }
  };

  if (loadError && !d) return <aside className="kb-panel" aria-label="Aufgabendetail"><PanelHead title="Aufgabe" onClose={onClose} /><Banner error={`Aufgabe nicht ladbar: ${loadError}`} /></aside>;
  if (!d) return <aside className="kb-panel" aria-label="Aufgabendetail"><PanelHead title="Aufgabe" onClose={onClose} /><p role="status">Aufgabe wird geladen…</p></aside>;

  const t = d.task;
  const changed: Record<string, string | number> = {};
  if (form.title.trim() !== t.title) changed.title = form.title.trim();
  if (form.body !== t.body) changed.body = form.body;
  if (form.priority !== t.priority) changed.priority = form.priority;
  if (form.status !== t.status) changed.status = form.status;
  if (form.status === "blocked" && form.block_reason.trim()) changed.block_reason = form.block_reason.trim();
  if (form.result !== (t.result ?? "") && form.result) changed.result = form.result;
  if (form.summary !== (t.summary ?? "") && form.summary) changed.summary = form.summary;
  const dirty = Object.keys(changed).length > 0 && !!form.title.trim();
  const titles = new Map([...allTasks.map((c) => [c.id, c.title] as const), ...d.link_tasks.map((c) => [c.id, c.title] as const)]);
  const linkable = allTasks.filter((c) => c.id !== t.id && !d.links.parents.includes(c.id) && !d.links.children.includes(c.id));

  const loadLog = async (tail: number) => {
    setLog((l) => ({ data: l?.data, tail, loading: true }));
    try { const r = await kanbanApi.log(host, board, id, tail); setLog({ data: r, tail, loading: false }); }
    catch (e) { setLog((l) => ({ data: l?.data, tail, loading: false, error: e instanceof Error ? e.message : String(e) })); }
  };
  const linkRow = (other: string, parent: string, child: string) => (
    <li key={other} className="row" style={{ gap: 8 }}>
      <span className="grow">{titles.get(other) ?? other} <span className="mono small t3">{other}</span></span>
      <button type="button" className="btn btn-s btn-g" aria-label={`Verknüpfung zu ${titles.get(other) ?? other} entfernen`} disabled={busy}
        onClick={() => void act(() => kanbanApi.unlink(host, board, parent, child), "Verknüpfung entfernt")}>Entfernen</button>
    </li>
  );

  return (
    <aside className="kb-panel" aria-label="Aufgabendetail">
      <PanelHead title={t.title} sub={`${t.id} · ${columnLabel(t.status)}`} onClose={onClose} />
      {d.diagnostics.map((g, i) => <p key={i} className="banner" role="note"><Icon name="alert" /><span><b>{g.title}</b>{g.detail && <> · {g.detail}</>}</span></p>)}
      {t.last_failure_error && <p className="banner" role="note"><Icon name="alert" /><span>Letzter Fehler ({t.consecutive_failures}×): {t.last_failure_error}</span></p>}
      <Banner error={error} />
      {note && !error && <p className="hint" role="status">{note}</p>}

      <form className="kb-sec" onSubmit={(e) => { e.preventDefault(); if (dirty) void act(() => kanbanApi.patchTask(host, board, id, changed), "Gespeichert", true); }}>
        <label className="col kb-lab">Titel<input className="field field-line" value={form.title} maxLength={300} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
        <div className="col kb-lab">
          <span className="row" style={{ gap: 8 }}>Text
            <span className="tabs" role="tablist" aria-label="Textansicht">
              <button type="button" role="tab" aria-selected={!preview} className={`tab${preview ? "" : " on"}`} onClick={() => setPreview(false)}>Bearbeiten</button>
              <button type="button" role="tab" aria-selected={preview} className={`tab${preview ? " on" : ""}`} onClick={() => setPreview(true)}>Vorschau</button>
            </span></span>
          {preview ? <div className="kb-prev">{form.body ? <Markdown text={form.body} /> : <span className="t3">Kein Text</span>}</div>
            : <textarea className="field" rows={8} aria-label="Text" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />}
        </div>
        <div className="row kb-grid">
          <label className="col kb-lab">Status<select className="field field-line" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            {columns.map((c) => <option key={c} value={c} disabled={c === "running" && t.status !== "running"}>{columnLabel(c)}</option>)}</select></label>
          <label className="col kb-lab">Priorität<input className="field field-line" type="number" min={-100} max={100} value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) || 0 })} /></label>
        </div>
        {form.status === "blocked" && <label className="col kb-lab">Blockiergrund<textarea className="field" rows={2} value={form.block_reason} onChange={(e) => setForm({ ...form, block_reason: e.target.value })} /></label>}
        {(form.status === "done" || form.status === "review") && <>
          <label className="col kb-lab">Ergebnis<textarea className="field" rows={2} value={form.result} onChange={(e) => setForm({ ...form, result: e.target.value })} /></label>
          <label className="col kb-lab">Zusammenfassung<textarea className="field" rows={3} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} /></label></>}
        <div className="row" style={{ gap: 8 }}>
          <button type="submit" className="btn btn-s btn-p" disabled={!dirty || busy}>Speichern</button>
          {dirty && <button type="button" className="btn btn-s btn-g" disabled={busy} onClick={() => void reload(true)}>Verwerfen</button>}
        </div>
      </form>

      <div className="kb-sec">
        <h3>Zuweisung</h3>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <select className="field field-line" aria-label="Zugewiesen an" value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Niemand</option>{assignees.map((a) => <option key={a} value={a}>{a}</option>)}</select>
          <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={reclaimFirst} onChange={(e) => setReclaimFirst(e.target.checked)} />Laufende Bearbeitung zuerst freigeben</label>
          <button type="button" className="btn btn-s" disabled={busy || who === (t.assignee ?? "")} onClick={() => void act(() => kanbanApi.reassign(host, board, id, who, reclaimFirst), "Neu zugewiesen", true)}>Neu zuweisen</button>
          {t.status === "running" && <button type="button" className="btn btn-s" disabled={busy} onClick={() => void act(() => kanbanApi.reclaim(host, board, id), "Freigegeben", true)}>Freigeben (reclaim)</button>}
        </div>
      </div>

      <div className="kb-sec">
        <h3>Verknüpfungen</h3>
        <ul className="kb-list" aria-label="Elternaufgaben">{d.links.parents.length === 0 ? <li className="t3 small">Keine Elternaufgaben</li> : d.links.parents.map((p) => linkRow(p, p, t.id))}</ul>
        <ul className="kb-list" aria-label="Kindaufgaben">{d.links.children.length === 0 ? <li className="t3 small">Keine Kindaufgaben</li> : d.links.children.map((c) => linkRow(c, t.id, c))}</ul>
        {linkable.length > 0 && <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <select className="field field-line" aria-label="Rolle der anderen Aufgabe" value={linkWith.role} onChange={(e) => setLinkWith({ ...linkWith, role: e.target.value })}>
            <option value="parent">Elternaufgabe</option><option value="child">Kindaufgabe</option></select>
          <select className="field field-line" aria-label="Andere Aufgabe" value={linkWith.other} onChange={(e) => setLinkWith({ ...linkWith, other: e.target.value })}>
            <option value="">Aufgabe wählen…</option>{linkable.map((c) => <option key={c.id} value={c.id}>{c.title} ({c.id})</option>)}</select>
          <button type="button" className="btn btn-s" disabled={busy || !linkWith.other}
            onClick={() => void act(() => linkWith.role === "parent" ? kanbanApi.link(host, board, linkWith.other, id) : kanbanApi.link(host, board, id, linkWith.other), "Verknüpft").then((ok) => ok && setLinkWith({ ...linkWith, other: "" }))}>Verknüpfen</button>
        </div>}
      </div>

      <div className="kb-sec">
        <h3>Kommentare ({d.comments.length})</h3>
        <ul className="kb-list">{d.comments.map((c, i) => <li key={c.id ?? i} className="kb-comment"><span className="small t3">{c.author ?? "unbekannt"} · {ts(c.created_at)}</span><Markdown text={c.body} /></li>)}
          {d.comments.length === 0 && <li className="t3 small">Noch keine Kommentare</li>}</ul>
        <form className="col" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); if (comment.trim()) void act(() => kanbanApi.comment(host, board, id, comment), "Kommentar gesendet").then((ok) => ok && setComment("")); }}>
          <textarea className="field" rows={3} aria-label="Neuer Kommentar" placeholder="Kommentar schreiben (Markdown)" value={comment} onChange={(e) => setComment(e.target.value)} />
          <div><button type="submit" className="btn btn-s" disabled={busy || !comment.trim()}>Kommentar senden</button></div>
        </form>
      </div>

      <div className="kb-sec">
        <h3>Verlauf</h3>
        {d.runs.length === 0 ? <p className="t3 small">Noch keine Läufe</p> : <ul className="kb-list" aria-label="Läufe">{d.runs.map((r, i) => (
          <li key={r.id ?? i}><b>{r.profile ?? "?"}</b> · {r.outcome ?? r.status} <span className="small t3">{ts(r.started_at)}</span>{r.summary && <div className="small">{r.summary}</div>}{r.error && <div className="small t3">Fehler: {r.error}</div>}</li>))}</ul>}
        <details><summary>Ereignisse ({d.events.length})</summary>
          <ul className="kb-list small">{d.events.map((e, i) => <li key={e.id ?? i}><span className="mono">{e.kind}</span> <span className="t3">{ts(e.created_at)}</span></li>)}</ul></details>
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn btn-s" disabled={log?.loading} onClick={() => void loadLog(LOG_STEP)}>{log?.data ? "Log neu laden" : "Log laden"}</button>
          {log?.data?.truncated && <button type="button" className="btn btn-s btn-g" disabled={log.loading} onClick={() => void loadLog(log.tail + LOG_STEP)}>Mehr Log laden</button>}
        </div>
        {log?.error && <Banner error={`Log nicht ladbar: ${log.error}`} />}
        {log?.data && (log.data.exists ? <pre className="kb-log" aria-label="Log">{log.data.content || "(leer)"}</pre> : <p className="t3 small">Für diese Aufgabe gibt es noch kein Log.</p>)}
      </div>

      <div className="kb-sec row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-s btn-d" disabled={busy} onClick={() => setArchive(true)}>Archivieren</button>
      </div>
      {archive && <ArchiveDialog task={t} onClose={() => setArchive(false)} onConfirm={async () => {
        assertBulk(await kanbanApi.bulk(host, board, { ids: [id], archive: true }));
        setArchive(false); onChanged(); onClose();
      }} />}
    </aside>
  );
}

function PanelHead({ title, sub, onClose }: { title: string; sub?: string; onClose: () => void }) {
  return (
    <header className="kb-phead">
      <div className="grow"><h2>{title}</h2>{sub && <span className="mono small t3">{sub}</span>}</div>
      <button type="button" className="btn btn-s btn-i" aria-label="Detail schließen" onClick={onClose}><Icon name="x" size={14} /></button>
    </header>
  );
}
