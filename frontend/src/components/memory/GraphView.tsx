import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { layout } from "../../graphLayout";
import { fmtCount } from "../../format";
import { useAsync } from "../../useAsync";
import { Icon } from "../Icon";

const W = 1000;
const H = 600;
const KIND_CLASSES = 6;
const LABEL_ROOM = 70;
/** Beschriftet werden Knoten mit Verbindungen und, solange der Graph klein ist, alle. */
const LABEL_ALL_UP_TO = 40;
const TOP_LABELS = 8;
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 6;

type View = { x: number; y: number; k: number };
const HOME: View = { x: 0, y: 0, k: 1 };

/** Toggle-Chip für Arten und Kantentypen: ein Klick blendet sie aus oder wieder ein. */
function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" className={`chip chip-s${on ? " on" : ""}`} aria-pressed={on} onClick={onClick}>{children}</button>;
}

/**
 * Wissensgraph des Gedächtnisses: Knoten und Kanten kräftebasiert angeordnet. Zoomen mit Mausrad oder Tasten, Verschieben durch
 * Ziehen. Ein Klick wählt einen Knoten: seine Nachbarn bleiben hell, der Rest tritt zurück. Arten und Kantentypen lassen sich
 * ausblenden, ebenso Knoten ohne Verbindung.
 */
export function GraphView({ provider }: { provider: string }) {
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string>();
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set());
  const [hiddenLinks, setHiddenLinks] = useState<Set<string>>(new Set());
  const [hideLoose, setHideLoose] = useState(false);
  const [view, setView] = useState<View>(HOME);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean }>();
  const state = useAsync(() => api.memoryGraph(provider, { q }), [provider, q]);
  const graph = state.data;

  const allKinds = useMemo(() => [...new Set((graph?.nodes ?? []).map((n) => n.kind ?? "—"))].sort(), [graph]);
  const allLinks = useMemo(() => [...new Set((graph?.edges ?? []).map((e) => e.label ?? "—"))].sort(), [graph]);
  const kindClass = (k: string | null) => `gk${allKinds.indexOf(k ?? "—") % KIND_CLASSES}`;

  // Was gezeigt wird: Arten und Kantentypen, die nicht ausgeblendet sind, auf Wunsch ohne Einzelgänger.
  const shown = useMemo(() => {
    if (!graph) return { nodes: [], edges: [], loose: 0 };
    let nodes = graph.nodes.filter((n) => !hiddenKinds.has(n.kind ?? "—"));
    const ids = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target) && !hiddenLinks.has(e.label ?? "—"));
    const linked = new Set(edges.flatMap((e) => [e.source, e.target]));
    const loose = nodes.filter((n) => !linked.has(n.id)).length;
    if (hideLoose) nodes = nodes.filter((n) => linked.has(n.id));
    return { nodes, edges, loose };
  }, [graph, hiddenKinds, hiddenLinks, hideLoose]);

  // Seitlich bleibt Platz für die Beschriftung der Randknoten.
  const placed = useMemo(() => layout(shown.nodes, shown.edges, W - 2 * LABEL_ROOM, H).map((p) => ({ ...p, x: p.x + LABEL_ROOM })), [shown]);
  const at = useMemo(() => new Map(placed.map((p) => [p.id, p])), [placed]);
  const nodeById = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph]);
  const top = useMemo(() => new Set([...placed].sort((a, b) => b.degree - a.degree).slice(0, TOP_LABELS).filter((p) => p.degree > 0).map((p) => p.id)), [placed]);
  const neighbours = useMemo(() => {
    if (!selected) return [];
    return shown.edges.flatMap((e) => (e.source === selected ? [{ id: e.target, label: e.label }] : e.target === selected ? [{ id: e.source, label: e.label }] : []));
  }, [shown, selected]);
  const near = useMemo(() => new Set(selected ? [selected, ...neighbours.map((n) => n.id)] : []), [selected, neighbours]);
  const sel = selected ? nodeById.get(selected) : undefined;

  const pick = (id: string) => setSelected((cur) => (cur === id ? undefined : id));
  const toggle = (set: Set<string>, put: (s: Set<string>) => void, key: string) => { const next = new Set(set); if (!next.delete(key)) next.add(key); put(next); setSelected(undefined); };

  const zoomAt = (factor: number, px = W / 2, py = H / 2) => setView((v) => {
    const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.k * factor));
    const f = k / v.k;
    return { k, x: px - (px - v.x) * f, y: py - (py - v.y) * f };
  });

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

  return (
    <div className="mem-graph">
      <form className="row mem-bar" role="search" onSubmit={(e) => { e.preventDefault(); setSelected(undefined); setQ(draft.trim()); }}>
        <label className="search grow">
          <Icon name="search" size={14} />
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Knoten eingrenzen, z. B. ein Name oder Thema" aria-label="Graph eingrenzen" />
        </label>
        <button type="submit" className="btn btn-s">Anzeigen</button>
        {q && <button type="button" className="btn btn-s btn-g" onClick={() => { setDraft(""); setQ(""); setSelected(undefined); }}>Zurücksetzen</button>}
      </form>

      {state.error && <p className="error small" role="alert">{state.error}</p>}
      {state.loading && <p className="muted small">Lade Graph…</p>}
      {graph && graph.nodes.length === 0 && !state.loading && <p className="panel-empty">Der Graph ist leer{q ? " für diese Eingrenzung" : ""}.</p>}

      {graph && graph.nodes.length > 0 && (
        <>
          <p className="muted small mono">
            {fmtCount(shown.nodes.length)} Knoten · {fmtCount(shown.edges.length)} Kanten
            {graph.truncated && ` · gekürzt, insgesamt ${fmtCount(graph.total)} Knoten (oben eingrenzen)`}
          </p>
          <div className="row mem-chips" role="group" aria-label="Arten">
            <span className="lbl">Arten</span>
            {allKinds.map((k) => (
              <Chip key={k} on={!hiddenKinds.has(k)} onClick={() => toggle(hiddenKinds, setHiddenKinds, k)}><i className={`swatch gk${allKinds.indexOf(k) % KIND_CLASSES}`} /> {k}</Chip>
            ))}
          </div>
          {allLinks.length > 1 && (
            <div className="row mem-chips" role="group" aria-label="Verbindungen">
              <span className="lbl">Verbindungen</span>
              {allLinks.map((l) => <Chip key={l} on={!hiddenLinks.has(l)} onClick={() => toggle(hiddenLinks, setHiddenLinks, l)}>{l}</Chip>)}
            </div>
          )}
          <div className="row graph-tools">
            <button type="button" className="btn btn-s btn-i" aria-label="Vergrößern" onClick={() => zoomAt(1.3)}><Icon name="plus" size={14} /></button>
            <button type="button" className="btn btn-s btn-i" aria-label="Verkleinern" onClick={() => zoomAt(1 / 1.3)}><span aria-hidden>−</span></button>
            <button type="button" className="btn btn-s btn-g" onClick={() => setView(HOME)} disabled={view === HOME || (view.k === 1 && view.x === 0 && view.y === 0)}>Ansicht zurücksetzen</button>
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
                  onClick={(e) => { if (e.target === e.currentTarget && !drag.current?.moved) setSelected(undefined); }}>
                  <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
                    {shown.edges.map((e, i) => {
                      const a = at.get(e.source), b = at.get(e.target);
                      if (!a || !b) return null;
                      const hot = selected && (e.source === selected || e.target === selected);
                      return (
                        <line key={i} className={`ge${hot ? " hot" : selected ? " dim" : ""}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} vectorEffect="non-scaling-stroke">
                          {e.label && <title>{e.label}</title>}
                        </line>
                      );
                    })}
                    {shown.nodes.map((n) => {
                      const p = at.get(n.id);
                      if (!p) return null;
                      const on = n.id === selected;
                      const showLabel = on || near.has(n.id) || shown.nodes.length <= LABEL_ALL_UP_TO || top.has(n.id) || view.k >= 2.2;
                      const r = (5 + Math.min(p.degree, 10)) / Math.sqrt(view.k);
                      return (
                        <g key={n.id} className={`gn ${kindClass(n.kind)}${on ? " on" : ""}${selected && !near.has(n.id) ? " dim" : ""}`} transform={`translate(${p.x} ${p.y})`}
                          role="button" tabIndex={0} aria-pressed={on} aria-label={`${n.label}${n.kind ? ` (${n.kind})` : ""}, ${p.degree} Verbindungen`}
                          onClick={(e) => { e.stopPropagation(); if (!drag.current?.moved) pick(n.id); }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(n.id); } }}>
                          <title>{n.label}</title>
                          <circle r={r} />
                          {showLabel && <text y={-(r + 4)} textAnchor="middle" fontSize={11 / Math.sqrt(view.k)}>{n.label.length > 24 ? `${n.label.slice(0, 23)}…` : n.label}</text>}
                        </g>
                      );
                    })}
                  </g>
                </svg>
              </div>
            </div>
            <aside className="r card" aria-label="Auswahl">
              {sel ? (
                <div className="wrow">
                  <b>{sel.label}</b>
                  {sel.kind && <span className="tag">{sel.kind}</span>}
                  <p className="lbl">Verbunden mit ({neighbours.length})</p>
                  {neighbours.length === 0 && <p className="muted small">Keine Kanten in diesem Ausschnitt.</p>}
                  <ul className="mem-plain">
                    {neighbours.map((nb, i) => (
                      <li key={`${nb.id}-${i}`}>
                        <button type="button" className="linkish" onClick={() => setSelected(nb.id)}>{nodeById.get(nb.id)?.label ?? nb.id}</button>
                        {nb.label && <span className="muted small"> · {nb.label}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : <p className="panel-empty">Einen Knoten anklicken, um seine Verbindungen zu sehen. Mausrad oder Tasten zoomen, Ziehen verschiebt.</p>}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
