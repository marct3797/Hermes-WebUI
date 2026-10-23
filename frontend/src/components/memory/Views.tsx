import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../../api";
import { fmtAgo, fmtCount } from "../../format";
import type { MemItem } from "../../types";
import { useAsync } from "../../useAsync";
import { Icon } from "../Icon";
import { Markdown } from "../Markdown";

export function ItemRow({ item }: { item: MemItem }) {
  return (
    <li className="mem-item">
      <p className="mem-text">{item.text}</p>
      <div className="row mem-meta">
        {item.kind && <span className="tag">{item.kind}</span>}
        {item.entities.slice(0, 6).map((e) => <span key={e} className="tag tag-m">{e}</span>)}
        {item.tags.slice(0, 4).map((t) => <span key={t} className="tag tag-m">#{t}</span>)}
        {item.context && <span className="muted small trunc" title={item.context}>{item.context}</span>}
        {item.at !== null && <span className="mono t3 small" style={{ marginLeft: "auto" }}>{fmtAgo(item.at)}</span>}
      </div>
    </li>
  );
}

const pretty = (key: string) => key.replace(/[._]/g, " ");

/** Übersicht: die Zähler, die der Anbieter für die Bank liefert. */
export function StatsView({ provider }: { provider: string }) {
  const state = useAsync(() => api.memoryStats(provider), [provider]);
  if (state.error) return <p className="error small" role="alert">{state.error}</p>;
  if (!state.data) return <p className="muted small">Lade…</p>;
  if (state.data.counts.length === 0) return <p className="panel-empty">Der Anbieter meldet keine Zähler.</p>;
  return (
    <div className="kpis mem-kpis">
      {state.data.counts.map((c) => (
        <div key={c.key} className="kpi"><span className="lbl">{pretty(c.key)}</span><span className="v">{fmtCount(c.value)}</span></div>
      ))}
    </div>
  );
}

/** Fakten und Beobachtungen: durchblättern, nach Art filtern, im Text suchen. */
export function ItemsView({ provider }: { provider: string }) {
  const [kind, setKind] = useState<string>();
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState("");
  const [rows, setRows] = useState<MemItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const [seen, setSeen] = useState<string[]>([]);

  const load = useCallback(async (offset: number) => {
    setBusy(true);
    setError(undefined);
    try {
      const page = await api.memoryItems(provider, { q, kind, offset, limit: 30 });
      setRows((cur) => (offset === 0 ? page.items : [...cur, ...page.items]));
      setTotal(page.total);
      setSeen((cur) => [...new Set([...cur, ...page.items.flatMap((i) => (i.kind ? [i.kind] : []))])].sort());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [provider, q, kind]);

  useEffect(() => { void load(0); }, [load]);
  const more = total === null ? rows.length > 0 && rows.length % 30 === 0 : rows.length < total;

  return (
    <div className="mem-items">
      <form className="row mem-bar" role="search" onSubmit={(e: FormEvent) => { e.preventDefault(); setQ(draft.trim()); }}>
        <label className="search grow">
          <Icon name="search" size={14} />
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="In den Fakten filtern" aria-label="Fakten filtern" />
        </label>
        <button type="submit" className="btn btn-s">Filtern</button>
      </form>
      {seen.length > 0 && (
        <div className="row mem-chips" role="group" aria-label="Art">
          <button type="button" className={`chip chip-s${kind === undefined ? " on" : ""}`} aria-pressed={kind === undefined} onClick={() => setKind(undefined)}>Alle</button>
          {seen.map((k) => <button key={k} type="button" className={`chip chip-s${kind === k ? " on" : ""}`} aria-pressed={kind === k} onClick={() => setKind(k)}>{k}</button>)}
        </div>
      )}
      {error && <p className="error small" role="alert">{error}</p>}
      {total !== null && <p className="muted small mono">{fmtCount(total)} Einträge</p>}
      <ul className="mem-list">{rows.map((i) => <ItemRow key={i.id} item={i} />)}</ul>
      {!busy && !error && rows.length === 0 && <p className="panel-empty">Nichts gefunden.</p>}
      {busy && <p className="muted small">Lade…</p>}
      {more && !busy && <button type="button" className="btn btn-s" onClick={() => void load(rows.length)}>Mehr laden</button>}
    </div>
  );
}

/** Semantische Suche (recall): liefert die Treffer, die der Anbieter einem Agenten geben würde. */
export function SearchView({ provider }: { provider: string }) {
  const [draft, setDraft] = useState("");
  const [asked, setAsked] = useState("");
  const state = useAsync(() => (asked ? api.memorySearch(provider, asked) : Promise.resolve(undefined)), [provider, asked]);
  return (
    <div className="mem-items">
      <form className="row mem-bar" role="search" onSubmit={(e) => { e.preventDefault(); setAsked(draft.trim()); }}>
        <label className="search grow">
          <Icon name="search" size={14} />
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Was soll der Agent dazu wissen?" aria-label="Gedächtnis durchsuchen" />
        </label>
        <button type="submit" className="btn btn-s btn-p" disabled={!draft.trim()}>Suchen</button>
      </form>
      {state.error && <p className="error small" role="alert">{state.error}</p>}
      {asked && state.loading && <p className="muted small">Suche…</p>}
      {state.data && (state.data.items.length === 0 ? <p className="panel-empty">Keine Treffer.</p> : <ul className="mem-list">{state.data.items.map((i) => <ItemRow key={i.id} item={i} />)}</ul>)}
      {!asked && <p className="panel-empty">Die Suche arbeitet wie der Abruf der Agents: Treffer nach Bedeutung, nicht nur nach Wortlaut.</p>}
    </div>
  );
}

/** Entitäten (Personen, Orte, Dinge) mit ihren Beobachtungen. */
export function EntitiesView({ provider }: { provider: string }) {
  const [selected, setSelected] = useState<string>();
  const list = useAsync(() => api.memoryEntities(provider, { limit: 100 }), [provider]);
  const detail = useAsync(() => (selected ? api.memoryEntity(provider, selected) : Promise.resolve(undefined)), [provider, selected]);
  if (list.error) return <p className="error small" role="alert">{list.error}</p>;
  if (!list.data) return <p className="muted small">Lade…</p>;
  if (list.data.items.length === 0) return <p className="panel-empty">Noch keine Entitäten.</p>;
  return (
    <div className="two">
      <div className="l">
        {list.data.total !== null && <p className="muted small mono">{fmtCount(list.data.total)} Entitäten{list.data.total > list.data.items.length ? `, ${list.data.items.length} angezeigt` : ""}</p>}
        <ul className="mem-ents">
          {list.data.items.map((e) => (
            <li key={e.id}>
              <button type="button" className={`ent${e.id === selected ? " on" : ""}`} aria-pressed={e.id === selected} onClick={() => setSelected(e.id === selected ? undefined : e.id)}>
                <span className="trunc">{e.name}</span><span className="mono t3 small">{fmtCount(e.mentions)}×</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <aside className="r card" aria-label="Entität">
        {!selected && <p className="panel-empty">Eine Entität wählen, um ihre Beobachtungen zu lesen.</p>}
        {selected && detail.loading && <p className="panel-empty">Lade…</p>}
        {detail.error && <p className="error small" role="alert" style={{ padding: 14 }}>{detail.error}</p>}
        {detail.data && (
          <div className="wrow">
            <b>{detail.data.name}</b>
            <p className="muted small mono">
              {fmtCount(detail.data.mentions)} Erwähnungen
              {detail.data.first_seen !== null && ` · erstmals ${fmtAgo(detail.data.first_seen)}`}
              {detail.data.last_seen !== null && ` · zuletzt ${fmtAgo(detail.data.last_seen)}`}
            </p>
            {detail.data.observations.length === 0 ? <p className="muted small">Keine Beobachtungen hinterlegt.</p> : <ul className="mem-list">{detail.data.observations.map((o) => <ItemRow key={o.id} item={o} />)}</ul>}
          </div>
        )}
      </aside>
    </div>
  );
}

/** Mentale Modelle: vom Anbieter verdichtete Zusammenfassungen zu einer Leitfrage. */
export function ModelsView({ provider }: { provider: string }) {
  const state = useAsync(() => api.memoryModels(provider), [provider]);
  if (state.error) return <p className="error small" role="alert">{state.error}</p>;
  if (!state.data) return <p className="muted small">Lade…</p>;
  if (state.data.items.length === 0) return <p className="panel-empty">Keine mentalen Modelle angelegt.</p>;
  return (
    <div className="mem-models">
      {state.data.items.map((m) => (
        <section key={m.id} className="card" aria-label={m.name}>
          <header className="card-h"><h2>{m.name}</h2>{m.updated !== null && <span className="mono t3 small" style={{ marginLeft: "auto" }}>aktualisiert {fmtAgo(m.updated)}</span>}</header>
          <div className="wrow">
            {m.query && <p className="muted small">Leitfrage: {m.query}</p>}
            {m.content ? <Markdown text={m.content} /> : <p className="muted small">Noch ohne Inhalt.</p>}
            {m.tags.length > 0 && <div className="row mem-meta">{m.tags.map((t) => <span key={t} className="tag tag-m">#{t}</span>)}</div>}
          </div>
        </section>
      ))}
    </div>
  );
}

/** Fragen an das Gedächtnis (reflect): der Anbieter antwortet mit einem Sprachmodell. Das kostet, darum nur auf Knopfdruck. */
export function ReflectView({ provider }: { provider: string }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [answer, setAnswer] = useState<{ q: string; text: string; basedOn: MemItem[] }>();
  const ask = async (e: FormEvent) => {
    e.preventDefault();
    const q = draft.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.memoryReflect(provider, q);
      setAnswer({ q, text: r.text, basedOn: r.based_on });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mem-items">
      <p className="muted small" style={{ maxWidth: 640 }}>Der Anbieter beantwortet die Frage aus dem Gedächtnis und ruft dafür ein Sprachmodell auf. Das verbraucht Kontingent; die Anzahl der Fragen ist begrenzt.</p>
      <form className="mem-ask" onSubmit={ask}>
        <textarea className="field" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="z. B. Was weiß ich über mein Zuhause-Netzwerk?" aria-label="Frage ans Gedächtnis" maxLength={1000} />
        <button type="submit" className="btn btn-p" disabled={busy || !draft.trim()}>{busy ? "Frage läuft…" : "Fragen"}</button>
      </form>
      {error && <p className="error small" role="alert">{error}</p>}
      {answer && (
        <section className="card" aria-label="Antwort">
          <header className="card-h"><h2>{answer.q}</h2></header>
          <div className="wrow">
            <Markdown text={answer.text} />
            {answer.basedOn.length > 0 && (
              <>
                <p className="lbl">Gestützt auf ({answer.basedOn.length})</p>
                <ul className="mem-list">{answer.basedOn.map((i) => <ItemRow key={i.id} item={i} />)}</ul>
              </>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
