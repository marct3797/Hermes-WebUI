import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { fmtCount } from "../../format";
import { analyze, type GNode } from "../../graphCluster";
import { arrange } from "../../graphLayout";
import { useAsync } from "../../useAsync";
import { Icon } from "../Icon";

const W = 1000;
const H = 600;
const PALETTE = 8;
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 8;
/** Bis zu dieser Größe bekommt jeder Knoten eine Beschriftung (soweit der Platz reicht), darüber nur Hubs, Auswahl und Nachbarn. */
const LABEL_ALL_UP_TO = 40;
const NEIGHBOURS_SHOWN = 12;
const BRIDGES_SHOWN = 10;

type View = { x: number; y: number; k: number };
const HOME: View = { x: 0, y: 0, k: 1 };

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Toggle-Chip: ein Klick blendet Arten und Verbindungstypen aus oder wieder ein. */
function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" className={`chip chip-s${on ? " on" : ""}`} aria-pressed={on} onClick={onClick}>{children}</button>;
}

type Box = { x: number; y: number; w: number; h: number };
const hits = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Wissensgraph des Gedächtnisses als Landkarte: Fakten, die zusammengehören, bilden eine Gruppe (Blase in einer eigenen Farbe,
 * betitelt mit ihrem wichtigsten Fakt). Gezeichnet werden nur die stärksten Verbindungen je Knoten und die Brücken zwischen Gruppen;
 * wählt man einen Knoten, kommen alle seine Verbindungen dazu. Beschriftungen überlappen nicht: was nicht passt, erscheint beim
 * Hineinzoomen oder bei Auswahl. Zoomen mit Mausrad oder Tasten, Ziehen verschiebt.
 */
export function GraphView({ provider }: { provider: string }) {
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string>();
  const [focus, setFocus] = useState<number>();
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set());
  const [hiddenLinks, setHiddenLinks] = useState<Set<string>>(new Set());
  const [hideLoose, setHideLoose] = useState(false);
  const [view, setView] = useState<View>(HOME);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean }>();
  const state = useAsync(() => api.memoryGraph(provider, { q }), [provider, q]);
  const graph = state.data;

  // Arten gibt es nur, wenn die Quelle sie liefert; sonst wären alle Knoten „—“ und die Chips nutzlos.
  const allKinds = useMemo(() => [...new Set((graph?.nodes ?? []).flatMap((n) => (n.kind ? [n.kind] : [])))].sort(), [graph]);
  const allLinks = useMemo(() => [...new Set((graph?.edges ?? []).map((e) => e.label ?? "—"))].sort(), [graph]);

  // Was gezeigt wird: Arten und Verbindungstypen, die nicht ausgeblendet sind, auf Wunsch ohne Einzelgänger.
  const shown = useMemo(() => {
    if (!graph) return { nodes: [] as GNode[], edges: [], loose: 0 };
    let nodes = graph.nodes.filter((n) => !n.kind || !hiddenKinds.has(n.kind));
    const ids = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target) && !hiddenLinks.has(e.label ?? "—"));
    const linked = new Set(edges.flatMap((e) => [e.source, e.target]));
    const loose = nodes.filter((n) => !linked.has(n.id)).length;
    if (hideLoose) nodes = nodes.filter((n) => linked.has(n.id));
    return { nodes, edges, loose };
  }, [graph, hiddenKinds, hiddenLinks, hideLoose]);

  const analysis = useMemo(() => analyze(shown.nodes, shown.edges), [shown]);
  const arranged = useMemo(() => arrange(analysis, shown.nodes.length, W, H), [analysis, shown.nodes.length]);
  const at = useMemo(() => new Map(arranged.nodes.map((p) => [p.index, p])), [arranged]);
  const indexOf = useMemo(() => new Map(shown.nodes.map((n, i) => [n.id, i])), [shown.nodes]);
  const selIndex = selected !== undefined ? indexOf.get(selected) : undefined;
  const sel = selIndex !== undefined ? shown.nodes[selIndex] : undefined;
  const bdeg = useMemo(() => {
    const d = new Array<number>(shown.nodes.length).fill(0);
    for (const l of analysis.backbone) { d[l.a]++; d[l.b]++; }
    return d;
  }, [analysis, shown.nodes.length]);
  /** Wichtige Knoten (viele starke Verbindungen im Gerüst) sind größer. */
  const radius = (i: number) => 4 + Math.min(bdeg[i], 12) * 0.55;
  const groupOf = (i: number) => analysis.group[i];
  const titleOf = (g: number) => shown.nodes[analysis.groups[g].hub].label;

  // Verbindungen des gewählten Knotens (alle, nach Stärke) und die Menge „nah dran“.
  const neighbours = useMemo(() => {
    if (selIndex === undefined) return [];
    return analysis.links.filter((l) => l.a === selIndex || l.b === selIndex).map((l) => ({ index: l.a === selIndex ? l.b : l.a, label: l.label, score: l.score }));
  }, [analysis, selIndex]);
  const near = useMemo(() => new Set(selIndex === undefined ? [] : [selIndex, ...neighbours.map((n) => n.index)]), [selIndex, neighbours]);

  // Brücken: die stärksten Verbindungen zwischen verschiedenen Gruppen, als eine Linie je Gruppenpaar zwischen den Hubs.
  const bridges = useMemo(() => {
    const sum = new Map<string, { a: number; b: number; w: number }>();
    for (const l of analysis.links) {
      const ga = analysis.group[l.a], gb = analysis.group[l.b];
      if (ga < 0 || gb < 0 || ga === gb) continue;
      const key = `${Math.min(ga, gb)}-${Math.max(ga, gb)}`;
      const had = sum.get(key);
      if (had) had.w += l.score; else sum.set(key, { a: Math.min(ga, gb), b: Math.max(ga, gb), w: l.score });
    }
    return [...sum.values()].sort((x, y) => y.w - x.w).slice(0, BRIDGES_SHOWN);
  }, [analysis]);
  const maxBridge = bridges[0]?.w ?? 1;

  // Beschriftungen ohne Überlappung. Reihenfolge der Wichtigkeit: Auswahl, Nachbarn, Hubs, dann nach Gewicht.
  const labelled = useMemo(() => {
    const k = view.k, font = 11 / k, charW = font * 0.6;
    const taken: Box[] = [];
    const out = new Map<number, string>();
    const strength = new Array<number>(shown.nodes.length).fill(0);
    for (const l of analysis.links) { strength[l.a] += l.score; strength[l.b] += l.score; }
    const everyone = shown.nodes.length <= LABEL_ALL_UP_TO || k >= 2.2;
    const rank = (i: number) => (i === selIndex ? 1e9 : 0) + (near.has(i) ? 1e6 : 0) + strength[i];
    const order = shown.nodes.map((_, i) => i).filter((i) => at.has(i)).sort((x, y) => rank(y) - rank(x) || x - y);
    for (const g of analysis.groups) { // Gruppentitel stehen fest über der Blase und blockieren ihren Platz
      const b = arranged.groups[g.id], t = cut(titleOf(g.id), 30), w = (t.length + 5) * (13 / k) * 0.6;
      taken.push({ x: b.x - w / 2, y: b.y - b.r - 18 / k, w, h: 15 / k });
    }
    for (const i of order) {
      const must = i === selIndex; // der Hub einer Gruppe heißt ohnehin wie ihr Titel; Nachbarn nur, soweit Platz ist
      if (!must && !everyone) continue;
      const p = at.get(i)!, text = cut(shown.nodes[i].label, 26), w = text.length * charW, r = radius(i) / Math.sqrt(k);
      const box = { x: p.x - w / 2, y: p.y - r - 4 / k - font, w, h: font * 1.15 };
      if (!must && taken.some((t) => hits(t, box))) continue;
      taken.push(box); out.set(i, text);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis, arranged, at, near, selIndex, shown.nodes, view.k, bdeg]);

  const pick = (id: string) => { setFocus(undefined); setSelected((cur) => (cur === id ? undefined : id)); };
  const toggle = (set: Set<string>, put: (s: Set<string>) => void, key: string) => { const next = new Set(set); if (!next.delete(key)) next.add(key); put(next); setSelected(undefined); setFocus(undefined); };

  const zoomAt = (factor: number, px = W / 2, py = H / 2) => setView((v) => {
    const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.k * factor));
    const f = k / v.k;
    return { k, x: px - (px - v.x) * f, y: py - (py - v.y) * f };
  });

  /** Eine Gruppe in den Rahmen holen. */
  const showGroup = (g: number) => {
    const b = arranged.groups[g];
    const k = Math.min(ZOOM_MAX, Math.max(1, 0.85 * Math.min(W / (2 * b.r), H / (2 * b.r))));
    setSelected(undefined); setFocus(g);
    setView({ k, x: W / 2 - b.x * k, y: H / 2 - b.y * k });
  };
  const home = () => { setView(HOME); setFocus(undefined); };

  // Mausrad: um den Zeiger zoomen. Muss ein nicht-passiver Listener sein, sonst scrollt die Seite mit.
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, ((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [graph]);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => { drag.current = { x: e.clientX, y: e.clientY, moved: false }; };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current, el = svg.current;
    if (!d || !el || e.buttons === 0) return;
    const r = el.getBoundingClientRect();
    const dx = ((e.clientX - d.x) / r.width) * W, dy = ((e.clientY - d.y) / r.height) * H;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.moved) { drag.current = { x: e.clientX, y: e.clientY, moved: true }; setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy })); }
  };
  const onPointerUp = () => { setTimeout(() => { drag.current = undefined; }, 0); };

  const colour = (g: number) => (g < 0 ? "gg-none" : `gg${analysis.groups[g].rank % PALETTE}`);
  const dimmed = (i: number) => (selIndex !== undefined ? !near.has(i) : focus !== undefined ? groupOf(i) !== focus : false);
  const atHome = view.k === 1 && view.x === 0 && view.y === 0;

  return (
    <div className="mem-graph">
      <form className="row mem-bar" role="search" onSubmit={(e) => { e.preventDefault(); setSelected(undefined); setFocus(undefined); setQ(draft.trim()); }}>
        <label className="search grow">
          <Icon name="search" size={14} />
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Knoten eingrenzen, z. B. ein Name oder Thema" aria-label="Graph eingrenzen" />
        </label>
        <button type="submit" className="btn btn-s">Anzeigen</button>
        {q && <button type="button" className="btn btn-s btn-g" onClick={() => { setDraft(""); setQ(""); setSelected(undefined); setFocus(undefined); }}>Zurücksetzen</button>}
      </form>

      {state.error && <p className="error small" role="alert">{state.error}</p>}
      {state.loading && <p className="muted small">Lade Graph…</p>}
      {graph && graph.nodes.length === 0 && !state.loading && <p className="panel-empty">Der Graph ist leer{q ? " für diese Eingrenzung" : ""}.</p>}

      {graph && graph.nodes.length > 0 && (
        <>
          <p className="muted small mono">
            <span>{fmtCount(shown.nodes.length)} Knoten · {fmtCount(shown.edges.length)} Kanten</span>
            {analysis.groups.length > 0 && <span> · {analysis.groups.length} Gruppen; gezeichnet sind je Knoten die stärksten Verbindungen</span>}
            {graph.truncated && <span> · gekürzt, insgesamt {fmtCount(graph.total)} Knoten (oben eingrenzen)</span>}
          </p>
          {allKinds.length > 0 && (
            <div className="row mem-chips" role="group" aria-label="Arten">
              <span className="lbl">Arten</span>
              {allKinds.map((k) => <Chip key={k} on={!hiddenKinds.has(k)} onClick={() => toggle(hiddenKinds, setHiddenKinds, k)}>{k}</Chip>)}
            </div>
          )}
          {allLinks.length > 1 && (
            <div className="row mem-chips" role="group" aria-label="Verbindungen">
              <span className="lbl">Verbindungen</span>
              {allLinks.map((l) => <Chip key={l} on={!hiddenLinks.has(l)} onClick={() => toggle(hiddenLinks, setHiddenLinks, l)}>{l}</Chip>)}
            </div>
          )}
          <div className="row graph-tools">
            <button type="button" className="btn btn-s btn-i" aria-label="Vergrößern" onClick={() => zoomAt(1.3)}><Icon name="plus" size={14} /></button>
            <button type="button" className="btn btn-s btn-i" aria-label="Verkleinern" onClick={() => zoomAt(1 / 1.3)}><span aria-hidden>−</span></button>
            <button type="button" className="btn btn-s btn-g" onClick={home} disabled={atHome && focus === undefined}>Ansicht zurücksetzen</button>
            <label className="row" style={{ gap: 6, marginLeft: "auto" }}>
              <input type="checkbox" checked={hideLoose} onChange={(e) => setHideLoose(e.target.checked)} />
              <span className="small">Einzelne ohne Verbindung ausblenden{shown.loose > 0 ? ` (${shown.loose})` : ""}</span>
            </label>
          </div>
          <div className="two">
            <div className="l">
              <div className="graph-wrap">
                <svg ref={svg} className="graph" viewBox={`0 0 ${W} ${H}`} role="group" aria-label="Wissensgraph" preserveAspectRatio="xMidYMid meet"
                  onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp}
                  onClick={(e) => { if (e.target === e.currentTarget && !drag.current?.moved) { setSelected(undefined); setFocus(undefined); } }}>
                  <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
                    {analysis.groups.map((g) => {
                      const b = arranged.groups[g.id];
                      return (
                        <g key={`b${g.id}`} className={`gb ${colour(g.id)}${focus !== undefined && focus !== g.id ? " dim" : ""}`}>
                          <circle cx={b.x} cy={b.y} r={b.r} className="bubble" onClick={(e) => { e.stopPropagation(); if (!drag.current?.moved) showGroup(g.id); }} />
                          <text x={b.x} y={b.y - b.r - 6 / view.k} textAnchor="middle" style={{ fontSize: 13 / view.k, strokeWidth: 3 / view.k }} className="gt">{cut(titleOf(g.id), 30)} · {g.members.length}</text>
                        </g>
                      );
                    })}
                    {bridges.map((b) => {
                      const a = at.get(analysis.groups[b.a].hub), c = at.get(analysis.groups[b.b].hub);
                      if (!a || !c) return null;
                      return <line key={`br${b.a}-${b.b}`} className={`ge bridge${selIndex !== undefined || focus !== undefined ? " dim" : ""}`} x1={a.x} y1={a.y} x2={c.x} y2={c.y} vectorEffect="non-scaling-stroke" strokeWidth={0.8 + 2.2 * (b.w / maxBridge)} />;
                    })}
                    {analysis.backbone.map((l, i) => {
                      const a = at.get(l.a), b = at.get(l.b);
                      if (!a || !b) return null;
                      if (groupOf(l.a) !== groupOf(l.b)) return null; // Verbindungen zwischen Gruppen zeichnen die Brücken
                      const hot = selIndex !== undefined && (l.a === selIndex || l.b === selIndex);
                      return <line key={`bb${i}`} className={`ge bb ${colour(groupOf(l.a))}${hot ? " hot" : dimmed(l.a) && dimmed(l.b) ? " dim" : ""}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} vectorEffect="non-scaling-stroke" />;
                    })}
                    {selIndex !== undefined && neighbours.slice(0, 40).map((nb) => {
                      const a = at.get(selIndex), b = at.get(nb.index);
                      if (!a || !b) return null;
                      return <line key={`hot${nb.index}`} className="ge hot" x1={a.x} y1={a.y} x2={b.x} y2={b.y} vectorEffect="non-scaling-stroke">{nb.label && <title>{nb.label}</title>}</line>;
                    })}
                    {shown.nodes.map((n, i) => {
                      const p = at.get(i);
                      if (!p) return null;
                      const on = i === selIndex;
                      const r = radius(i) / Math.sqrt(view.k);
                      const text = labelled.get(i);
                      return (
                        <g key={n.id} className={`gn ${colour(groupOf(i))}${on ? " on" : ""}${dimmed(i) ? " dim" : ""}`} transform={`translate(${p.x} ${p.y})`}
                          role="button" tabIndex={0} aria-pressed={on} aria-label={`${n.label}${n.kind ? ` (${n.kind})` : ""}, ${analysis.degree[i]} Verbindungen`}
                          onClick={(e) => { e.stopPropagation(); if (!drag.current?.moved) pick(n.id); }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(n.id); } }}>
                          <title>{n.label}</title>
                          <circle r={r} />
                          {text && <text y={-(r + 4 / view.k)} textAnchor="middle" style={{ fontSize: 11 / view.k, strokeWidth: 3 / view.k }}>{text}</text>}
                        </g>
                      );
                    })}
                  </g>
                </svg>
              </div>
            </div>
            <aside className="r card" aria-label="Auswahl">
              {sel && selIndex !== undefined ? (
                <div className="wrow">
                  <b>{sel.label}</b>
                  {sel.kind && <span className="tag">{sel.kind}</span>}
                  {groupOf(selIndex) >= 0 && (
                    <p className="small"><i className={`swatch ${colour(groupOf(selIndex))}`} /> Gruppe <button type="button" className="linkish" onClick={() => showGroup(groupOf(selIndex))}>{cut(titleOf(groupOf(selIndex)), 40)}</button></p>
                  )}
                  <p className="lbl">Verbunden mit ({neighbours.length})</p>
                  {neighbours.length === 0 && <p className="muted small">Keine Kanten in diesem Ausschnitt.</p>}
                  <ul className="mem-plain">
                    {neighbours.slice(0, NEIGHBOURS_SHOWN).map((nb) => (
                      <li key={nb.index}>
                        <button type="button" className="linkish" onClick={() => setSelected(shown.nodes[nb.index].id)}>{shown.nodes[nb.index].label}</button>
                        {nb.label && <span className="muted small"> · {nb.label}</span>}
                      </li>
                    ))}
                  </ul>
                  {neighbours.length > NEIGHBOURS_SHOWN && <p className="muted small">… und {neighbours.length - NEIGHBOURS_SHOWN} weitere, schwächere.</p>}
                </div>
              ) : analysis.groups.length > 0 ? (
                <div className="wrow">
                  <p className="lbl">Gruppen</p>
                  <ul className="mem-plain graph-groups">
                    {analysis.groups.map((g) => (
                      <li key={g.id}>
                        <button type="button" className={`linkish${focus === g.id ? " on" : ""}`} aria-pressed={focus === g.id} onClick={() => showGroup(g.id)}>
                          <i className={`swatch ${colour(g.id)}`} /> {cut(titleOf(g.id), 44)} <span className="muted small">· {g.members.length}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  <p className="muted small">Eine Gruppe oder einen Knoten anklicken. Mausrad oder Tasten zoomen, Ziehen verschiebt.</p>
                </div>
              ) : <p className="panel-empty">Einen Knoten anklicken, um seine Verbindungen zu sehen. Mausrad oder Tasten zoomen, Ziehen verschiebt.</p>}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
