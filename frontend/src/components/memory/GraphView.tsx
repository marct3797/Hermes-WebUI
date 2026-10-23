import { useMemo, useState } from "react";
import { api } from "../../api";
import { layout } from "../../graphLayout";
import { fmtCount } from "../../format";
import { useAsync } from "../../useAsync";
import { Icon } from "../Icon";

const W = 1000;
const H = 600;
const KIND_CLASSES = 6;
/** Beschriftet werden Knoten mit Verbindungen und, solange der Graph klein ist, alle. */
const LABEL_ALL_UP_TO = 40;

/** Wissensgraph des Gedächtnisses: Knoten und Kanten kräftebasiert angeordnet, Klick zeigt die Nachbarn. */
export function GraphView({ provider }: { provider: string }) {
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string>();
  const state = useAsync(() => api.memoryGraph(provider, { q }), [provider, q]);
  const graph = state.data;

  const placed = useMemo(() => (graph ? layout(graph.nodes, graph.edges, W, H) : []), [graph]);
  const at = useMemo(() => new Map(placed.map((p) => [p.id, p])), [placed]);
  const nodeById = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph]);
  const kinds = useMemo(() => [...new Set((graph?.nodes ?? []).map((n) => n.kind ?? "—"))].sort(), [graph]);
  const kindClass = (k: string | null) => `gk${kinds.indexOf(k ?? "—") % KIND_CLASSES}`;
  const neighbours = useMemo(() => {
    if (!graph || !selected) return [];
    return graph.edges.flatMap((e) => (e.source === selected ? [{ id: e.target, label: e.label }] : e.target === selected ? [{ id: e.source, label: e.label }] : []));
  }, [graph, selected]);
  const sel = selected ? nodeById.get(selected) : undefined;

  const pick = (id: string) => setSelected((cur) => (cur === id ? undefined : id));

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
            {fmtCount(graph.nodes.length)} Knoten · {fmtCount(graph.edges.length)} Kanten
            {graph.truncated && ` · gekürzt, insgesamt ${fmtCount(graph.total)} Knoten (oben eingrenzen)`}
          </p>
          <div className="two">
            <div className="l">
              <svg className="graph" viewBox={`0 0 ${W} ${H}`} role="group" aria-label="Wissensgraph" preserveAspectRatio="xMidYMid meet">
                {graph.edges.map((e, i) => {
                  const a = at.get(e.source), b = at.get(e.target);
                  if (!a || !b) return null;
                  const hot = selected && (e.source === selected || e.target === selected);
                  return (
                    <line key={i} className={`ge${hot ? " hot" : ""}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}>
                      {e.label && <title>{e.label}</title>}
                    </line>
                  );
                })}
                {graph.nodes.map((n) => {
                  const p = at.get(n.id);
                  if (!p) return null;
                  const on = n.id === selected;
                  const showLabel = on || graph.nodes.length <= LABEL_ALL_UP_TO || p.degree >= 3;
                  return (
                    <g key={n.id} className={`gn ${kindClass(n.kind)}${on ? " on" : ""}`} transform={`translate(${p.x} ${p.y})`}
                      role="button" tabIndex={0} aria-pressed={on} aria-label={`${n.label}${n.kind ? ` (${n.kind})` : ""}, ${p.degree} Verbindungen`}
                      onClick={() => pick(n.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(n.id); } }}>
                      <circle r={5 + Math.min(p.degree, 10)} />
                      {showLabel && <text y={-(9 + Math.min(p.degree, 10))} textAnchor="middle">{n.label.length > 28 ? `${n.label.slice(0, 27)}…` : n.label}</text>}
                    </g>
                  );
                })}
              </svg>
              <ul className="legend" aria-label="Legende">
                {kinds.map((k) => <li key={k}><i className={`swatch gk${kinds.indexOf(k) % KIND_CLASSES}`} />{k}</li>)}
              </ul>
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
              ) : <p className="panel-empty">Einen Knoten anklicken, um seine Verbindungen zu sehen.</p>}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
