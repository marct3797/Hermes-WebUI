import { useMemo, useState } from "react";
import { api } from "../../api";
import { fmtCount } from "../../format";
import { COLOR_MODES, colorNodes, LINK_NAMES, linkColor, recencyColor, type ColorMode } from "../../graphColor";
import { analyze } from "../../graphCluster";
import { useAsync } from "../../useAsync";
import { Icon } from "../Icon";
import { Constellation } from "./Constellation";
import { dayLabel, GraphTable, GraphTimeline, type Range } from "./GraphTable";

export const FACT_TYPES = [{ id: "world", label: "Weltfakten" }, { id: "experience", label: "Erfahrung" }, { id: "observation", label: "Beobachtungen" }] as const;
export const LIMIT_STEPS = [500, 1000, 2000];
const VIEWS = [{ id: "map", label: "Konstellation" }, { id: "table", label: "Tabelle" }, { id: "timeline", label: "Zeitleiste" }] as const;
type ViewId = (typeof VIEWS)[number]["id"];
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export type GraphInit = { type?: string; limit?: number; q?: string; tags?: string[]; tags_match?: string };
/** Liest die Teilen-Adresse (`?tab=graph&type=…`); Unsinn fällt auf die Vorgaben zurück. */
export function readGraphQuery(search: string): GraphInit & { tab?: string } {
  const p = new URLSearchParams(search), limit = Number(p.get("limit"));
  const tags = p.getAll("tags").filter(Boolean).slice(0, 10);
  return {
    tab: p.get("tab") ?? undefined, type: FACT_TYPES.find((t) => t.id === p.get("type"))?.id,
    limit: Number.isInteger(limit) && limit >= 1 && limit <= 2000 ? limit : undefined, q: p.get("q")?.slice(0, 200) || undefined,
    tags: tags.length ? tags : undefined, tags_match: p.get("tags_match") === "all" ? "all" : undefined,
  };
}

/**
 * Gedächtnis-Graph nach dem Vorbild der Hindsight-Control-Plane: Reiter je Faktenart, Filter, „Weitere laden“ (mehr Knoten, bis 2000),
 * Darstellung als Konstellation, Tabelle oder Zeitleiste. Hindsight kennt kein `offset`: mehr laden heißt, `limit` zu erhöhen.
 */
export function GraphView({ provider, initial = {} }: { provider: string; initial?: GraphInit }) {
  const [type, setType] = useState(initial.type ?? "world");
  const [limit, setLimit] = useState(initial.limit ?? LIMIT_STEPS[0]);
  const [q, setQ] = useState(initial.q ?? "");
  const [draft, setDraft] = useState(initial.q ?? "");
  const [tags, setTags] = useState<string[]>(initial.tags ?? []);
  const [tagDraft, setTagDraft] = useState((initial.tags ?? []).join(", "));
  const [tagsMatch, setTagsMatch] = useState(initial.tags_match ?? "any");
  const [view, setView] = useState<ViewId>("map");
  const [mode, setMode] = useState<ColorMode>("recency");
  const [hiddenLinks, setHiddenLinks] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string>();
  const [highlight, setHighlight] = useState(false);
  const [range, setRange] = useState<Range>();
  const [attempt, setAttempt] = useState(0);
  const [shareNote, setShareNote] = useState<string>();

  const state = useAsync(() => api.memoryGraph(provider, { type, limit, q, tags, tags_match: tags.length > 1 ? tagsMatch : undefined, refresh: attempt > 0 }), [provider, type, limit, q, tags, tagsMatch, attempt]);
  const stats = useAsync(() => api.memoryStats(provider).catch(() => undefined), [provider]);
  const graph = state.data;
  const countOf = (t: string) => stats.data?.counts.find((c) => c.key === `nodes_by_fact_type.${t}`)?.value;

  const edges = useMemo(() => (graph?.edges ?? []).filter((e) => !hiddenLinks.has(e.type ?? "?")), [graph, hiddenLinks]);
  const linkTypes = useMemo(() => {
    const n = new Map<string, number>();
    for (const e of graph?.edges ?? []) n.set(e.type ?? "?", (n.get(e.type ?? "?") ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1]);
  }, [graph]);
  const grouping = useMemo(() => {
    if (mode !== "group" || !graph) return undefined;
    const a = analyze(graph.nodes, edges.map((e) => ({ source: e.source, target: e.target, label: e.type, weight: e.weight })));
    return { of: a.group, titles: a.groups.map((g) => cut(graph.nodes[g.hub].label, 40)) }; // Gruppen-ID = Position
  }, [mode, graph, edges]);
  const coloring = useMemo(() => colorNodes(mode, graph?.nodes ?? [], grouping), [mode, graph, grouping]);
  const rows = useMemo(() => (graph?.table_rows.length ? graph.table_rows : (graph?.nodes ?? []).map((n) => ({ id: n.id, text: n.text ?? n.label, context: n.context, entities: n.entities, date: n.date, kind: n.kind }))), [graph]);
  const selIndex = selectedId !== undefined && graph ? graph.nodes.findIndex((n) => n.id === selectedId) : -1;
  const sel = selIndex >= 0 ? graph!.nodes[selIndex] : undefined;
  const connections = useMemo(() => {
    if (!sel || !graph) return { byType: [] as Array<[string, number]>, list: [] as Array<{ id: string; label: string; type: string | null }> };
    const label = new Map(graph.nodes.map((n) => [n.id, n.label]));
    const mine = graph.edges.filter((e) => e.source === sel.id || e.target === sel.id);
    const n = new Map<string, number>();
    for (const e of mine) n.set(e.type ?? "?", (n.get(e.type ?? "?") ?? 0) + 1);
    return { byType: [...n].sort((a, b) => b[1] - a[1]), list: mine.slice(0, 12).map((e) => { const id = e.source === sel.id ? e.target : e.source; return { id, label: label.get(id) ?? id, type: e.type }; }) };
  }, [sel, graph]);

  const reset = () => { setSelectedId(undefined); setRange(undefined); setHighlight(false); };
  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    reset();
    setQ(draft.trim());
    setTags(tagDraft.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 10));
  };
  const nextLimit = LIMIT_STEPS.find((s) => s > limit);
  const moreExist = !!graph && graph.returned < graph.total && graph.returned >= graph.limit;
  const toggleLink = (t: string) => { const next = new Set(hiddenLinks); if (!next.delete(t)) next.add(t); setHiddenLinks(next); };

  const share = async () => {
    const p = new URLSearchParams({ tab: "graph", type, limit: String(limit) });
    if (q) p.set("q", q);
    for (const t of tags) p.append("tags", t);
    if (tags.length > 1 && tagsMatch === "all") p.set("tags_match", "all");
    const url = `${location.origin}${location.pathname}?${p}`;
    try { await navigator.clipboard.writeText(url); setShareNote("Link kopiert"); } catch { setShareNote(`Kopieren nicht möglich. Adresse: ${url}`); }
  };

  const label = graph ? `Gedächtnis-Graph, ${fmtCount(graph.nodes.length)} Erinnerungen und ${fmtCount(edges.length)} Verbindungen, gefärbt nach ${COLOR_MODES.find((m) => m.id === mode)!.label}. Pfeiltasten verschieben, Plus und Minus zoomen, 0 zeigt alles. Dieselben Erinnerungen stehen in der Ansicht Tabelle.` : "";

  return (
    <div className="mem-graph">
      <div className="tabs" role="tablist" aria-label="Faktenart">
        {FACT_TYPES.map((t) => (
          <button key={t.id} type="button" role="tab" className={`tab${t.id === type ? " on" : ""}`} aria-selected={t.id === type}
            onClick={() => { if (t.id !== type) { reset(); setType(t.id); setLimit(LIMIT_STEPS[0]); } }}>
            {t.label}{countOf(t.id) !== undefined && <span className="n">{fmtCount(countOf(t.id)!)}</span>}
          </button>
        ))}
      </div>

      <form className="row mem-bar" role="search" onSubmit={apply}>
        <label className="search grow"><Icon name="search" size={14} />
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Nach Text oder Kontext filtern" aria-label="Nach Text oder Kontext filtern" />
        </label>
        <label className="search"><input value={tagDraft} onChange={(e) => setTagDraft(e.target.value)} placeholder="Tags, mit Komma getrennt" aria-label="Nach Tags filtern" /></label>
        {tags.length > 1 && (
          <select className="field field-line" value={tagsMatch} onChange={(e) => setTagsMatch(e.target.value)} aria-label="Tags kombinieren">
            <option value="any">mindestens ein Tag</option><option value="all">alle Tags</option>
          </select>
        )}
        <button type="submit" className="btn btn-s">Filtern</button>
        {(q || tags.length > 0) && <button type="button" className="btn btn-s btn-g" onClick={() => { setDraft(""); setQ(""); setTagDraft(""); setTags([]); reset(); }}>Zurücksetzen</button>}
      </form>

      {state.error && (
        <p className="error small" role="alert">Graph nicht ladbar: {state.error} <button type="button" className="btn btn-s" onClick={() => setAttempt((a) => a + 1)}>Erneut versuchen</button></p>
      )}
      {state.loading && <div className="graph-skeleton" role="status" aria-label="Lade Graph" />}
      {graph && !state.loading && (
        <>
          <div className="row graph-count">
            <p className="muted small mono" role="status">{fmtCount(graph.returned)} von {fmtCount(graph.total)} Erinnerungen werden angezeigt{graph.edges_dropped > 0 ? ` · ${fmtCount(graph.edges_dropped)} schwächere Verbindungen nicht gezeichnet` : ""}</p>
            {moreExist && nextLimit && <button type="button" className="btn btn-s" onClick={() => { reset(); setLimit(nextLimit); }}>Weitere laden</button>}
            {moreExist && !nextLimit && (
              <>
                <button type="button" className="btn btn-s" disabled>Weitere laden</button>
                <span className="muted small">Mehr als 2.000 zeigt die Hindsight-Control-Plane unter Daten.</span>
              </>
            )}
            <div className="seg" role="group" aria-label="Darstellung" style={{ marginLeft: "auto" }}>
              {VIEWS.map((v) => <button key={v.id} type="button" className={view === v.id ? "on" : undefined} aria-pressed={view === v.id} onClick={() => setView(v.id)}>{v.label}</button>)}
            </div>
          </div>

          {graph.nodes.length === 0 ? <p className="panel-empty">Keine Erinnerungen für diesen Filter</p> : (
            <div className="two">
              <div className="l">
                {view === "map" && (
                  <Constellation nodes={graph.nodes} edges={edges} colors={coloring.colors} selected={selIndex >= 0 ? selIndex : undefined} highlight={highlight}
                    onSelect={(i) => setSelectedId(i === undefined ? undefined : graph.nodes[i].id)} label={label} onShare={() => void share()} shareNote={shareNote}>
                    <div className="graph-panel graph-colors">
                      <label className="row small" style={{ gap: 6 }}><span className="lbl">Einfärben nach</span>
                        <select className="field field-line" value={mode} onChange={(e) => setMode(e.target.value as ColorMode)} aria-label="Einfärben nach">
                          {COLOR_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                        </select></label>
                      {coloring.scale ? (
                        <div className="graph-scale" aria-label={`Aktualität von ${dayLabel(coloring.scale.min)} bis ${dayLabel(coloring.scale.max)}`}>
                          <i style={{ background: `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map(recencyColor).join(",")})` }} />
                          <span className="small mono">{dayLabel(coloring.scale.min)} (alt)</span><span className="small mono">(neu) {dayLabel(coloring.scale.max)}</span>
                        </div>
                      ) : (
                        <ul className="legend">{coloring.legend.map((l) => <li key={l.label}><i className="swatch" style={{ background: l.color }} />{cut(l.label, 28)} <span className="muted">{fmtCount(l.count)}</span></li>)}</ul>
                      )}
                    </div>
                    {linkTypes.length > 0 && (
                      <fieldset className="graph-panel graph-links"><legend className="lbl">Verknüpfungstypen</legend>
                        {linkTypes.map(([t, n]) => (
                          <label key={t} className="row small" style={{ gap: 6 }}>
                            <input type="checkbox" checked={!hiddenLinks.has(t)} onChange={() => toggleLink(t)} />
                            <i className="swatch" style={{ background: linkColor(t === "?" ? null : t) }} />{LINK_NAMES[t] ?? (t === "?" ? "Ohne Typ" : t)} <span className="muted">{fmtCount(n)}</span>
                          </label>
                        ))}
                      </fieldset>
                    )}
                  </Constellation>
                )}
                {view === "table" && <GraphTable rows={rows} selectedId={selectedId} onSelect={setSelectedId} range={range} onClearRange={() => setRange(undefined)} />}
                {view === "timeline" && (
                  <>
                    <GraphTimeline provider={provider} type={type} rows={rows} range={range} onRange={setRange} />
                    <GraphTable rows={rows} selectedId={selectedId} onSelect={setSelectedId} range={range} onClearRange={() => setRange(undefined)} />
                  </>
                )}
              </div>
              <aside className="r card" aria-label="Auswahl">
                {sel ? (
                  <div className="wrow">
                    <p className="mem-text">{sel.text ?? sel.label}</p>
                    <p className="muted small mono">{[sel.date ? new Date(sel.date).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" }) : null, sel.context].filter(Boolean).join(" · ") || "Ohne Datum und Kontext"}</p>
                    {sel.entities.length > 0 && <div className="row mem-meta" aria-label="Entitäten">{sel.entities.map((e) => <span key={e} className="tag">{e}</span>)}</div>}
                    <p className="lbl">Verbindungen ({connections.byType.reduce((s, [, n]) => s + n, 0)})</p>
                    {connections.byType.length === 0 ? <p className="muted small">Keine Verbindungen in diesem Ausschnitt.</p> : (
                      <ul className="legend">{connections.byType.map(([t, n]) => <li key={t}><i className="swatch" style={{ background: linkColor(t === "?" ? null : t) }} />{LINK_NAMES[t] ?? t} {n}</li>)}</ul>
                    )}
                    <button type="button" className="btn btn-s" aria-pressed={highlight} onClick={() => setHighlight((h) => !h)} disabled={connections.list.length === 0}>Nachbarn hervorheben</button>
                    <ul className="mem-plain">
                      {connections.list.map((c, i) => <li key={`${c.id}${i}`}><button type="button" className="linkish" onClick={() => setSelectedId(c.id)}>{cut(c.label, 60)}</button>{c.type && <span className="muted small"> · {LINK_NAMES[c.type] ?? c.type}</span>}</li>)}
                    </ul>
                  </div>
                ) : <p className="panel-empty">Einen Punkt oder eine Zeile anklicken, um Text, Entitäten und Verbindungen zu sehen.</p>}
              </aside>
            </div>
          )}
        </>
      )}
    </div>
  );
}
