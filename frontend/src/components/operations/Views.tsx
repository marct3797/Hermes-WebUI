import { useState } from "react";
import { enc, labels, type Listing, type Source } from "./http";

export type Ask = (label: string, url: string, body: Record<string, string>, method?: string) => void;
export function Kanban({ data, base, ask }: { data: Listing; base: string; ask: Ask }) {
  const [view, setView] = useState("columns");
  const tasks = data.tasks ?? data.items;
  if (!Array.isArray(tasks) || tasks.some(task => typeof task.title !== "string" || typeof task.status !== "string")) return <p role="alert">Antwortformat nicht unterstützt.</p>;
  const columns = [...new Set([...(data.columns ?? []), ...tasks.map(task => task.status!)])];
  return <>
    <label>Ansicht <select className="field field-line" value={view} onChange={e => setView(e.target.value)}><option value="columns">Spalten</option><option value="list">Liste</option></select></label>
    {tasks.length === 0 && <p className="empty">Keine Aufgaben vorhanden.</p>}
    <div className={view === "columns" ? "ops-columns" : "ops-stack"}>{columns.map(column => <section className="ops-column" key={column} aria-label={column}>
      <h2>{column}</h2><ul className="ops-list">{tasks.filter(task => task.status === column).map(task => <li className="card ops-card" key={task.id}>
        <h3>{task.title}</h3>{task.description && <p className="ops-text">{task.description}</p>}
        {task.transitions && task.transitions.length > 0 && <form className="ops-toolbar" onSubmit={e => { e.preventDefault(); const status = new FormData(e.currentTarget).get("status") as string; if (task.transitions?.includes(status)) ask(`${task.title} nach ${status} verschieben?`, `${base}/transition`, { id: task.id, status }); }}>
          <select className="field" name="status" aria-label={`Status für ${task.title}`} defaultValue={task.transitions[0]}>{task.transitions.map(status => <option key={status}>{status}</option>)}</select><button className="btn btn-s">Verschieben</button>
        </form>}
      </li>)}</ul>
    </section>)}</div>
  </>;
}
export function Jobs({ data, base, ask }: { data: Listing; base: string; ask: Ask }) {
  if (!Array.isArray(data.jobs)) return <p role="alert">Antwortformat nicht unterstützt.</p>;
  return data.jobs.length === 0 ? <p className="empty">Keine Jobs vorhanden.</p> : <ul className="ops-list">{data.jobs.map(job => <li className="card ops-card" key={job.id}>
    <h2>{job.name || job.id}</h2><p className="muted">{job.status ?? (job.paused === true ? "Pausiert" : job.paused === false ? "Aktiv" : "Status unbekannt")}</p>
    {(job.actions ?? data.actions)?.includes("edit") && typeof job.schedule === "string" ? <form className="ops-toolbar" onSubmit={e => { e.preventDefault(); const schedule = String(new FormData(e.currentTarget).get("schedule") ?? "").trim(); if (schedule) ask(`Zeitplan für ${job.name || job.id} ändern?`, `${base}/${enc(job.id)}`, { schedule }, "PATCH"); }}>
      <label>Zeitplan<input className="field" required maxLength={500} name="schedule" aria-label={`Zeitplan für ${job.name || job.id}`} defaultValue={job.schedule} /></label><button className="btn btn-s">Zeitplan speichern</button>
    </form> : <p>{job.schedule ?? "Kein Zeitplan gemeldet"}</p>}
    <div className="ops-toolbar">{["pause", "resume"].filter(action => (job.actions ?? data.actions)?.includes(action)).map(action => <button type="button" className="btn btn-s" key={action} onClick={() => ask(`${job.name || job.id}: ${labels[action]}?`, `${base}/${enc(job.id)}/${action}`, {})}>{labels[action]}</button>)}</div>
  </li>)}</ul>;
}
export function ManagedItems({ data, base, ask }: { data: Listing; base: string; ask: Ask }) {
  if (!Array.isArray(data.items)) return <p role="alert">Antwortformat nicht unterstützt.</p>;
  return data.items.length === 0 ? <p className="empty">Keine Einträge vorhanden.</p> : <ul className="ops-list">{data.items.map(item => <li className="card ops-card" key={item.id}>
    <h2>{item.label || item.name || item.id}</h2>{item.description && <p className="ops-text">{item.description}</p>}
    <p className="muted">{item.enabled === true ? "Aktiviert" : item.enabled === false ? "Deaktiviert" : item.status ?? "Status unbekannt"}</p>
    <div className="ops-toolbar">{["enable", "disable"].filter(action => (item.actions ?? data.actions)?.includes(action)).map(action => <button className="btn btn-s" type="button" key={action} onClick={() => ask(`${item.name || item.id}: ${labels[action]}?`, `${base}/${action}`, { id: item.id })}>{labels[action]}</button>)}</div>
  </li>)}</ul>;
}
export function Logs({ data }: { data: Listing }) {
  if (data.redacted === false) return <p role="alert">Redaktion nicht bestätigt. Logausgabe wird aus Sicherheitsgründen nicht angezeigt.</p>;
  if (typeof data.content !== "string") return <p role="alert">Antwortformat nicht unterstützt.</p>;
  return <><p className="muted">Serverseitig redigierte Ausgabe; maximal 64 KiB Text. Keine Live-Übertragung.</p>{(data.truncated || data.content.length > 65536) && <p role="status">Ausgabe gekürzt.</p>}{data.content ? <pre className="card ops-log" tabIndex={0} aria-label="Redigierte Logs">{data.content.slice(-65536)}</pre> : <p className="empty">Keine Logeinträge vorhanden.</p>}</>;
}
export function Marketplaces({ sources, base, ask }: { sources: Source[]; base?: string; ask: Ask }) {
  return <>
    <p className="banner">Erweiterungen können Code ausführen. Quellcode und Berechtigungen vor der Installation prüfen. Eine geprüfte Quelle ist keine Sicherheitsgarantie.</p>
    {sources.length === 0 && <p className="empty">Keine geprüften Quellen konfiguriert.</p>}
    <ul className="ops-list">{sources.map(source => <li key={source.id} className="card ops-card">
      <h2>{source.label || source.name || source.id}</h2>
      {source.url && /^https:\/\//i.test(source.url) && <a href={source.url} target="_blank" rel="noopener noreferrer">Quelle öffnen</a>}
      <p>{source.reviewed === true ? "Quelle geprüft" : "Quelle nicht zur Installation freigegeben"}{source.trust ? ` · ${source.trust}` : ""}</p>
      {source.description && <p className="ops-text">{source.description}</p>}
      {source.requirements?.map((requirement, i) => <p className="muted" key={i}>{requirement}</p>)}
      {base && source.reviewed === true && ["skills", "mcp", "plugins"].includes(source.kind ?? "") && source.installable !== false && source.actions?.includes("install") && <button className="btn btn-s" type="button" onClick={() => ask(`${source.label || source.id} installieren? Ich habe Quelle und Berechtigungen geprüft und vertraue dem Code.`, `${base}/${source.kind}/install`, { id: source.id })}>Installieren</button>}
    </li>)}</ul>
  </>;
}
