import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../../api";
import { fmtAgo, fmtCount } from "../../format";
import type { MemItem } from "../../types";
import { useAsync } from "../../useAsync";
import { Icon } from "../Icon";
import { Markdown } from "../Markdown";
import { t as tr } from "../../i18n";

/** Sprünge zwischen den Ansichten: eine Entität öffnen, Fakten nach einem Begriff filtern. */
export type Nav = { entity: (name: string) => void; facts: (q: string) => void };

export function ItemRow({ item, nav, active, onOpen }: { item: MemItem; nav?: Nav; active?: boolean; onOpen?: (item: MemItem) => void }) {
  return (
    <li className={`mem-item${active ? " on" : ""}`}>
      {onOpen ? (
        <button type="button" className="mem-open" aria-pressed={!!active} aria-label={tr("Fakt öffnen: {v}", { v: item.text.slice(0, 60) })} onClick={() => onOpen(item)}>
          <span className="mem-text">{item.text}</span>
        </button>
      ) : <p className="mem-text">{item.text}</p>}
      <div className="row mem-meta">
        {item.kind && <span className="tag">{item.kind}</span>}
        {item.entities.slice(0, 6).map((e) => nav
          ? <button key={e} type="button" className="tag tag-m tag-btn" title={tr("Zur Entität {e}", { e })} onClick={() => nav.entity(e)}>{e}</button>
          : <span key={e} className="tag tag-m">{e}</span>)}
        {item.tags.slice(0, 4).map((t) => nav
          ? <button key={t} type="button" className="tag tag-m tag-btn" title={tr("Fakten mit #{v} suchen", { v: t })} onClick={() => nav.facts(t)}>#{t}</button>
          : <span key={t} className="tag tag-m">#{t}</span>)}
        {item.context && <span className="muted small trunc" title={item.context}>{item.context}</span>}
        {item.at !== null && <span className="mono t3 small" style={{ marginLeft: "auto" }}>{fmtAgo(item.at)}</span>}
      </div>
    </li>
  );
}

/** Ein Fakt ganz: voller Text, Herkunft, Entitäten und Tags zum Weiterklicken. Geändert wird hier nichts (siehe Hinweis). */
export function ItemDetail({ item, nav, onClose }: { item: MemItem; nav: Nav; onClose: () => void }) {
  return (
    <aside className="r card" aria-label={tr("Fakt")}>
      <div className="wrow">
        <div className="row" style={{ gap: 8 }}>
          {item.kind && <span className="tag">{item.kind}</span>}
          <button type="button" className="btn btn-s btn-i btn-g" style={{ marginLeft: "auto" }} aria-label={tr("Fakt schließen")} onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <p className="mem-text">{item.text}</p>
        {item.context && <p className="muted small">{tr("Kontext: {context}", { context: item.context })}</p>}
        {item.entities.length > 0 && (
          <>
            <p className="lbl">{tr("Entitäten")}</p>
            <div className="row mem-meta">{item.entities.map((e) => <button key={e} type="button" className="tag tag-m tag-btn" onClick={() => nav.entity(e)}>{e}</button>)}</div>
          </>
        )}
        {item.tags.length > 0 && (
          <>
            <p className="lbl">{tr("Tags")}</p>
            <div className="row mem-meta">{item.tags.map((t) => <button key={t} type="button" className="tag tag-m tag-btn" onClick={() => nav.facts(t)}>#{t}</button>)}</div>
          </>
        )}
        <p className="mono t3 small">
          {tr("{null}{document}ID {id}", { null: item.at !== null && `erfasst ${fmtAgo(item.at)} · `, document: item.document ? `Dokument ${item.document} · ` : "", id: item.id })}</p>
        <p className="muted small">{tr("Hindsight bietet keine Schnittstelle, um einen einzelnen Fakt zu ändern; die WebUI schreibt darum nicht ins Gedächtnis. Entitäten und Tags oben führen zu allem, was dazu gehört.")}</p>
      </div>
    </aside>
  );
}

const pretty = (key: string) => key.replace(/[._]/g, " ");

const TILE_LABELS: Record<string, string> = {
  total_nodes: "Fakten", total_links: "Verknüpfungen", total_documents: "Dokumente", total_entities: "Entitäten",
  pending_operations: "Offene Aufgaben", failed_operations: "Fehlgeschlagene Aufgaben", pending_consolidation: "Warten auf Verdichtung",
};
const GROUP_LABELS: Record<string, string> = { nodes_by_fact_type: "Fakten nach Art", get links_by_link_type() { return tr("Verknüpfungen nach Art"); } };
const KIND_LABELS: Record<string, string> = { world: "Weltwissen", experience: "Erfahrungen", observation: "Beobachtungen", opinion: "Meinungen" };
const KIND_CLASSES = 6;

/** Balken, der eine Gesamtzahl auf ihre Anteile aufteilt, mit Legende. */
function Split({ title, rows }: { title: string; rows: Array<{ key: string; value: number }> }) {
  const total = rows.reduce((n, r) => n + r.value, 0);
  if (total <= 0) return null;
  return (
    <section className="card mem-split" aria-label={title}>
      <header className="card-h"><h2>{title}</h2><span className="mono t3 small" style={{ marginLeft: "auto" }}>{fmtCount(total)}</span></header>
      <div className="wrow">
        <div className="splitbar" role="img" aria-label={rows.map((r) => `${KIND_LABELS[r.key] ?? r.key} ${r.value}`).join(", ")}>
          {rows.map((r, i) => <span key={r.key} className={`seg gk${i % KIND_CLASSES}`} style={{ flex: r.value }} title={`${KIND_LABELS[r.key] ?? r.key}: ${fmtCount(r.value)}`} />)}
        </div>
        <ul className="legend">
          {rows.map((r, i) => <li key={r.key}><i className={`swatch gk${i % KIND_CLASSES}`} />{KIND_LABELS[r.key] ?? r.key}<span className="mono t3 small"> {fmtCount(r.value)} · {Math.round((r.value / total) * 100)} %</span></li>)}
        </ul>
      </div>
    </section>
  );
}

/** Übersicht: die Zähler des Anbieters, aufgeteilt nach Art, dazu das Neueste und die häufigsten Entitäten zum Weiterklicken. */
export function StatsView({ provider, nav }: { provider: string; nav?: Nav }) {
  const state = useAsync(() => api.memoryStats(provider), [provider]);
  const recent = useAsync(() => api.memoryItems(provider, { limit: 5 }), [provider]);
  const ents = useAsync(() => api.memoryEntities(provider, { limit: 60 }), [provider]);
  if (state.error) return <p className="error small" role="alert">{state.error}</p>;
  if (!state.data) return <p className="muted small">{tr("Lade…")}</p>;
  if (state.data.counts.length === 0) return <p className="panel-empty">{tr("Der Anbieter meldet keine Zähler.")}</p>;

  const tiles = state.data.counts.filter((c) => !c.key.includes(".") && !(/^(pending|failed)/.test(c.key) && c.value === 0));
  const groups = new Map<string, Array<{ key: string; value: number }>>();
  for (const c of state.data.counts) {
    const dot = c.key.indexOf(".");
    if (dot > 0 && c.value > 0) groups.set(c.key.slice(0, dot), [...(groups.get(c.key.slice(0, dot)) ?? []), { key: c.key.slice(dot + 1), value: c.value }]);
  }
  const top = [...(ents.data?.items ?? [])].sort((a, b) => b.mentions - a.mentions).slice(0, 12);
  return (
    <div className="mem-stats">
      <div className="kpis mem-kpis">
        {tiles.map((c) => (
          <div key={c.key} className="kpi"><span className="lbl">{TILE_LABELS[c.key] ?? pretty(c.key)}</span><span className="v">{fmtCount(c.value)}</span></div>
        ))}
      </div>
      {groups.size > 0 && (
        <div className="mem-splits">
          {[...groups].map(([g, rows]) => <Split key={g} title={GROUP_LABELS[g] ?? pretty(g)} rows={rows.sort((a, b) => b.value - a.value)} />)}
        </div>
      )}
      {top.length > 0 && nav && (
        <section className="card" aria-label={tr("Häufigste Entitäten")}>
          <header className="card-h"><h2>{tr("Häufigste Entitäten")}</h2></header>
          <div className="wrow">
            <div className="row mem-meta" style={{ flexWrap: "wrap" }}>
              {top.map((e) => <button key={e.id} type="button" className="chip chip-s" onClick={() => nav.entity(e.name)}>{e.name} <span className="mono t3 small">{fmtCount(e.mentions)}×</span></button>)}
            </div>
          </div>
        </section>
      )}
      {recent.data && recent.data.items.length > 0 && (
        <section className="card" aria-label={tr("Zuletzt gemerkt")}>
          <header className="card-h"><h2>{tr("Zuletzt gemerkt")}</h2>{nav && <button type="button" className="btn btn-s btn-g" style={{ marginLeft: "auto" }} onClick={() => nav.facts("")}>{tr("Alle Fakten")}</button>}</header>
          <ul className="mem-list">{recent.data.items.map((i) => <ItemRow key={i.id} item={i} nav={nav} />)}</ul>
        </section>
      )}
    </div>
  );
}

/** Fakten und Beobachtungen: durchblättern, nach Art filtern, im Text suchen. */
export function ItemsView({ provider, nav, initialQuery = "" }: { provider: string; nav: Nav; initialQuery?: string }) {
  const [kind, setKind] = useState<string>();
  const [q, setQ] = useState(initialQuery);
  const [draft, setDraft] = useState(initialQuery);
  const [open, setOpen] = useState<MemItem>();
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
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={tr("In den Fakten filtern")} aria-label={tr("Fakten filtern")} />
        </label>
        <button type="submit" className="btn btn-s">{tr("Filtern")}</button>
      </form>
      {seen.length > 0 && (
        <div className="row mem-chips" role="group" aria-label={tr("Art")}>
          <button type="button" className={`chip chip-s${kind === undefined ? " on" : ""}`} aria-pressed={kind === undefined} onClick={() => setKind(undefined)}>{tr("Alle")}</button>
          {seen.map((k) => <button key={k} type="button" className={`chip chip-s${kind === k ? " on" : ""}`} aria-pressed={kind === k} onClick={() => setKind(k)}>{k}</button>)}
        </div>
      )}
      {error && <p className="error small" role="alert">{error}</p>}
      {total !== null && <p className="muted small mono">{tr("{total} Einträge", { total: fmtCount(total) })}</p>}
      {q && <p className="muted small">{tr("Gefiltert nach „")}{q}“ <button type="button" className="linkish" onClick={() => { setDraft(""); setQ(""); }}>{tr("aufheben")}</button></p>}
      <div className={open ? "two" : undefined}>
        <div className="l">
          <ul className="mem-list">{rows.map((i) => <ItemRow key={i.id} item={i} nav={nav} active={open?.id === i.id} onOpen={(it) => setOpen(open?.id === it.id ? undefined : it)} />)}</ul>
          {!busy && !error && rows.length === 0 && <p className="panel-empty">{tr("Nichts gefunden.")}</p>}
          {busy && <p className="muted small">{tr("Lade…")}</p>}
          {more && !busy && <button type="button" className="btn btn-s" onClick={() => void load(rows.length)}>{tr("Mehr laden")}</button>}
        </div>
        {open && <ItemDetail item={open} nav={nav} onClose={() => setOpen(undefined)} />}
      </div>
    </div>
  );
}

/** Semantische Suche (recall): liefert die Treffer, die der Anbieter einem Agenten geben würde. */
export function SearchView({ provider, nav }: { provider: string; nav: Nav }) {
  const [open, setOpen] = useState<MemItem>();
  const [draft, setDraft] = useState("");
  const [asked, setAsked] = useState("");
  const state = useAsync(() => (asked ? api.memorySearch(provider, asked) : Promise.resolve(undefined)), [provider, asked]);
  return (
    <div className="mem-items">
      <form className="row mem-bar" role="search" onSubmit={(e) => { e.preventDefault(); setAsked(draft.trim()); }}>
        <label className="search grow">
          <Icon name="search" size={14} />
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={tr("Was soll der Agent dazu wissen?")} aria-label={tr("Gedächtnis durchsuchen")} />
        </label>
        <button type="submit" className="btn btn-s btn-p" disabled={!draft.trim()}>{tr("Suchen")}</button>
      </form>
      {state.error && <p className="error small" role="alert">{state.error}</p>}
      {asked && state.loading && <p className="muted small">{tr("Suche…")}</p>}
      {state.data && (state.data.items.length === 0 ? <p className="panel-empty">{tr("Keine Treffer.")}</p> : (
        <div className={open ? "two" : undefined}>
          <div className="l"><ul className="mem-list">{state.data.items.map((i) => <ItemRow key={i.id} item={i} nav={nav} active={open?.id === i.id} onOpen={(it) => setOpen(open?.id === it.id ? undefined : it)} />)}</ul></div>
          {open && <ItemDetail item={open} nav={nav} onClose={() => setOpen(undefined)} />}
        </div>
      ))}
      {!asked && <p className="panel-empty">{tr("Die Suche arbeitet wie der Abruf der Agents: Treffer nach Bedeutung, nicht nur nach Wortlaut.")}</p>}
    </div>
  );
}

/** Entitäten (Personen, Orte, Dinge): suchen, öffnen, zu ihren Fakten springen. `initial`: Name, der beim Öffnen gewählt wird. */
export function EntitiesView({ provider, nav, initial }: { provider: string; nav: Nav; initial?: string }) {
  const [selected, setSelected] = useState<string>();
  const [filter, setFilter] = useState(initial ?? "");
  const list = useAsync(() => api.memoryEntities(provider, { limit: 200 }), [provider]);
  const detail = useAsync(() => (selected ? api.memoryEntity(provider, selected) : Promise.resolve(undefined)), [provider, selected]);
  // Kam der Besucher über einen Namen (aus einem Fakt), wird die passende Entität gleich geöffnet.
  useEffect(() => {
    if (!initial || !list.data) return;
    const hit = list.data.items.find((e) => e.name.toLowerCase() === initial.toLowerCase());
    if (hit) setSelected(hit.id);
  }, [initial, list.data]);
  if (list.error) return <p className="error small" role="alert">{list.error}</p>;
  if (!list.data) return <p className="muted small">{tr("Lade…")}</p>;
  if (list.data.items.length === 0) return <p className="panel-empty">{tr("Noch keine Entitäten.")}</p>;
  const shown = [...list.data.items].filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase())).sort((a, b) => b.mentions - a.mentions);
  return (
    <div className="two">
      <div className="l">
        <label className="search" style={{ marginBottom: 8 }}>
          <Icon name="search" size={14} />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={tr("Entitäten filtern")} aria-label={tr("Entitäten filtern")} />
        </label>
        {list.data.total !== null && <p className="muted small mono">{tr("{total} Entitäten{v}{v2}", { total: fmtCount(list.data.total), v: list.data.total > list.data.items.length ? `, ${list.data.items.length} geladen` : "", v2: filter ? ` · ${shown.length} passen` : "" })}</p>}
        <ul className="mem-ents">
          {shown.map((e) => (
            <li key={e.id}>
              <button type="button" className={`ent${e.id === selected ? " on" : ""}`} aria-pressed={e.id === selected} onClick={() => setSelected(e.id === selected ? undefined : e.id)}>
                <span className="trunc">{e.name}</span><span className="mono t3 small">{fmtCount(e.mentions)}×</span>
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="panel-empty">{tr("Keine Entität passt.")}</li>}
        </ul>
      </div>
      <aside className="r card" aria-label={tr("Entität")}>
        {!selected && <p className="panel-empty">{tr("Eine Entität wählen, um ihre Beobachtungen zu lesen.")}</p>}
        {selected && detail.loading && <p className="panel-empty">{tr("Lade…")}</p>}
        {detail.error && <p className="error small" role="alert" style={{ padding: 14 }}>{detail.error}</p>}
        {detail.data && (
          <div className="wrow">
            <b>{detail.data.name}</b>
            <p className="muted small mono">
              {tr("{mentions} Erwähnungen{null}{null2}", { mentions: fmtCount(detail.data.mentions), null: detail.data.first_seen !== null && ` · erstmals ${fmtAgo(detail.data.first_seen)}`, null2: detail.data.last_seen !== null && ` · zuletzt ${fmtAgo(detail.data.last_seen)}` })}</p>
            <div className="row" style={{ gap: 6 }}>
              <button type="button" className="btn btn-s" onClick={() => nav.facts(detail.data!.name)}>{tr("Alle Fakten dazu")}</button>
            </div>
            {detail.data.observations.length === 0 ? <p className="muted small">{tr("Keine Beobachtungen hinterlegt.")}</p> : <ul className="mem-list">{detail.data.observations.map((o) => <ItemRow key={o.id} item={o} nav={nav} />)}</ul>}
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
  if (!state.data) return <p className="muted small">{tr("Lade…")}</p>;
  if (state.data.items.length === 0) return <p className="panel-empty">{tr("Keine mentalen Modelle angelegt.")}</p>;
  return (
    <div className="mem-models">
      {state.data.items.map((m) => (
        <section key={m.id} className="card" aria-label={m.name}>
          <header className="card-h"><h2>{m.name}</h2>{m.updated !== null && <span className="mono t3 small" style={{ marginLeft: "auto" }}>{tr("aktualisiert {updated}", { updated: fmtAgo(m.updated) })}</span>}</header>
          <div className="wrow">
            {m.query && <p className="muted small">{tr("Leitfrage: {query}", { query: m.query })}</p>}
            {m.content ? <Markdown text={m.content} /> : <p className="muted small">{tr("Noch ohne Inhalt.")}</p>}
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
      <p className="muted small" style={{ maxWidth: 640 }}>{tr("Der Anbieter beantwortet die Frage aus dem Gedächtnis und ruft dafür ein Sprachmodell auf. Das verbraucht Kontingent; die Anzahl der Fragen ist begrenzt.")}</p>
      <form className="mem-ask" onSubmit={ask}>
        <textarea className="field" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={tr("z. B. Was weiß ich über mein Zuhause-Netzwerk?")} aria-label={tr("Frage ans Gedächtnis")} maxLength={1000} />
        <button type="submit" className="btn btn-p" disabled={busy || !draft.trim()}>{busy ? tr("Frage läuft…") : tr("Fragen")}</button>
      </form>
      {error && <p className="error small" role="alert">{error}</p>}
      {answer && (
        <section className="card" aria-label={tr("Antwort")}>
          <header className="card-h"><h2>{answer.q}</h2></header>
          <div className="wrow">
            <Markdown text={answer.text} />
            {answer.basedOn.length > 0 && (
              <>
                <p className="lbl">{tr("Gestützt auf ({v})", { v: answer.basedOn.length })}</p>
                <ul className="mem-list">{answer.basedOn.map((i) => <ItemRow key={i.id} item={i} />)}</ul>
              </>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
