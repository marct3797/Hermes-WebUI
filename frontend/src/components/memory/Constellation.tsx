import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { robustBounds, createSim, fitView, hitTest, settled, setEdges, step, toScreen, type Sim, type View } from "../../graphForce";
import { linkColor } from "../../graphColor";
import type { MemEdge, MemNode } from "../../types";
import { t as tr } from "../../i18n";

const WARMUP = 100;
const W0 = 1000, H0 = 600; // Maße, solange das Element keine Größe meldet (Tests)
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

type Props = {
  nodes: MemNode[]; edges: MemEdge[]; colors: string[];
  selected?: number; highlight: boolean; onSelect: (index: number | undefined) => void;
  label: string; onShare: () => void; shareNote?: string; children?: React.ReactNode;
};

/**
 * Konstellation: Knoten als leuchtende Punkte auf dunklem Canvas, Kräfte-Layout (graphForce.ts). Mausrad zoomt um den Zeiger,
 * Ziehen verschiebt, Doppelklick zentriert, Klick wählt. Pfeile verschieben, + und − zoomen, 0 zeigt alles.
 * Die Kanten, die der Aufrufer übergibt, zeichnen UND ziehen: ausgeblendete Verknüpfungstypen fehlen im Layout.
 */
export function Constellation({ nodes, edges, colors, selected, highlight, onSelect, label, onShare, shareNote, children }: Props) {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const sim = useRef<Sim>(undefined as unknown as Sim);
  const view = useRef<View>({ x: 0, y: 0, k: 1 });
  const size = useRef({ w: W0, h: H0 });
  const frame = useRef(0);
  const autoFit = useRef(true); // folgt der Wolke, bis jemand zoomt oder verschiebt
  const dirty = useRef(true);
  const [paused, setPaused] = useState(false);
  const [full, setFull] = useState(false);
  const [hover, setHover] = useState<{ i: number; x: number; y: number }>();
  const hoverRef = useRef<number>(-1);
  const drag = useRef<{ x: number; y: number; moved: boolean } | undefined>(undefined);
  const live = useRef({ nodes, edges, colors, selected, highlight, paused });
  live.current = { nodes, edges, colors, selected, highlight, paused };

  const index = useMemo(() => new Map(nodes.map((n, i) => [n.id, i])), [nodes]);
  const pairs = useMemo(() => edges.flatMap((e) => { const a = index.get(e.source), b = index.get(e.target); return a === undefined || b === undefined || a === b ? [] : [[a, b, e.weight ?? 1] as [number, number, number]]; }), [edges, index]);
  const degree = useMemo(() => { const d = new Int32Array(nodes.length); for (const [a, b] of pairs) { d[a]++; d[b]++; } return d; }, [pairs, nodes.length]);
  const near = useMemo(() => {
    const s = new Set<number>();
    if (selected !== undefined) { s.add(selected); for (const [a, b] of pairs) { if (a === selected) s.add(b); if (b === selected) s.add(a); } }
    return s;
  }, [pairs, selected]);

  const draw = useCallback(() => {
    const el = canvas.current, ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const { nodes: ns, colors: cs, selected: sel, highlight: hl } = live.current;
    const w = el.clientWidth || W0, h = el.clientHeight || H0, dpr = Math.min(2, window.devicePixelRatio || 1);
    size.current = { w, h };
    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) { el.width = Math.round(w * dpr); el.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const s = sim.current, v = view.current;
    const px = (i: number) => toScreen(v, w, h, s.x[i], s.y[i]);
    const dim = hl && sel !== undefined;
    // Kanten je Typ in einem Pfad
    const byType = new Map<string, number[]>();
    live.current.edges.forEach((e, ei) => { const t = e.type ?? "?"; (byType.get(t) ?? byType.set(t, []).get(t)!).push(ei); });
    ctx.lineWidth = 1;
    for (const [t, list] of byType) {
      ctx.strokeStyle = linkColor(t === "?" ? null : t);
      for (const pass of dim ? [false, true] : [false]) {
        ctx.globalAlpha = pass ? 0.9 : dim ? 0.05 : Math.min(0.35, 0.06 + 60 / Math.max(list.length, 1));
        ctx.beginPath();
        for (const ei of list) {
          const e = live.current.edges[ei], a = index.get(e.source), b = index.get(e.target);
          if (a === undefined || b === undefined) continue;
          if (dim && pass !== (a === sel || b === sel)) continue;
          const p = px(a), q = px(b);
          ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y);
        }
        ctx.stroke();
      }
    }
    for (let i = 0; i < ns.length; i++) {
      const p = px(i);
      if (p.x < -20 || p.y < -20 || p.x > w + 20 || p.y > h + 20) continue;
      const r = (2.2 + Math.min(degree[i], 12) * 0.22) * Math.min(2.2, Math.sqrt(Math.max(v.k, 0.3)));
      ctx.fillStyle = cs[i] ?? "#6b7280";
      ctx.globalAlpha = dim && !near.has(i) ? 0.12 : 0.2; // Leuchten
      ctx.beginPath(); ctx.arc(p.x, p.y, r * 2.4, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = dim && !near.has(i) ? 0.25 : 1;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      if (i === sel || i === hoverRef.current) {
        ctx.globalAlpha = 1; ctx.strokeStyle = "#fff"; ctx.lineWidth = i === sel ? 2 : 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, r + 3, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }, [degree, index, near]);

  // Ein Bild pro Anfrage; die Schleife ruht, sobald Layout ruht und nichts zu zeichnen ist.
  const kick = useCallback(() => {
    dirty.current = true;
    if (frame.current) return;
    const tick = () => {
      frame.current = 0;
      const s = sim.current;
      if (s && !live.current.paused && !settled(s)) { step(s); step(s); dirty.current = true; }
      if (s && autoFit.current) { const el = canvas.current; if (el?.clientWidth) size.current = { w: el.clientWidth, h: el.clientHeight || H0 }; const t = fitView(robustBounds(s), size.current.w, size.current.h), v = view.current, a = settled(s) ? 1 : 0.25; view.current = { k: v.k + (t.k - v.k) * a, x: v.x + (t.x - v.x) * a, y: v.y + (t.y - v.y) * a }; dirty.current = true; }
      if (dirty.current) { dirty.current = false; draw(); }
      if (s && !live.current.paused && !settled(s)) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }, [draw]);

  const fit = useCallback(() => { autoFit.current = true; view.current = fitView(robustBounds(sim.current), size.current.w, size.current.h); kick(); }, [kick]);

  // Neue Knotenmenge: frisches Layout, kurz vorgewärmt, dann einpassen.
  useEffect(() => {
    const s = createSim(nodes.length);
    sim.current = s;
    setEdges(s, pairs);
    for (let i = 0; i < WARMUP; i++) step(s);
    autoFit.current = true;
    view.current = fitView(robustBounds(s), size.current.w, size.current.h);
    kick();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nur bei neuer Knotenmenge neu anlegen
  }, [nodes]);
  // Nur die Kanten geändert (Typ ausgeblendet): Positionen behalten, aber neu erhitzen.
  useEffect(() => { if (sim.current && sim.current.n === nodes.length) { setEdges(sim.current, pairs); kick(); } }, [pairs]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { kick(); }, [colors, selected, highlight, paused, kick]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const zoomAt = useCallback((factor: number, mx?: number, my?: number) => {
    autoFit.current = false;
    const v = view.current, { w, h } = size.current;
    const k = Math.min(20, Math.max(0.05, v.k * factor)), f = k / v.k;
    const ox = (mx ?? w / 2) - w / 2, oy = (my ?? h / 2) - h / 2; // Zeiger relativ zur Mitte
    view.current = { k, x: ox - (ox - v.x) * f, y: oy - (oy - v.y) * f };
    kick();
  }, [kick]);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => { e.preventDefault(); const p = local(e); zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, p.x, p.y); };
    el.addEventListener("wheel", onWheel, { passive: false }); // nicht passiv, sonst scrollt die Seite mit
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const onPointerDown = (e: React.PointerEvent) => { drag.current = { x: e.clientX, y: e.clientY, moved: false }; };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d && e.buttons) {
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      if (d.moved) { autoFit.current = false; drag.current = { x: e.clientX, y: e.clientY, moved: true }; view.current = { ...view.current, x: view.current.x + dx, y: view.current.y + dy }; kick(); }
      return;
    }
    const p = local(e), i = hitTest(sim.current, view.current, size.current.w, size.current.h, p.x, p.y);
    if (i !== hoverRef.current) { hoverRef.current = i; setHover(i >= 0 ? { i, x: p.x, y: p.y } : undefined); kick(); }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = undefined;
    if (d?.moved) return;
    const p = local(e), i = hitTest(sim.current, view.current, size.current.w, size.current.h, p.x, p.y);
    onSelect(i >= 0 && i !== selected ? i : undefined);
  };
  const onDoubleClick = (e: React.MouseEvent) => { // Punkt unter dem Zeiger in die Mitte holen
    autoFit.current = false;
    const p = local(e), { w, h } = size.current;
    view.current = { ...view.current, x: view.current.x - (p.x - w / 2), y: view.current.y - (p.y - h / 2) };
    kick();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const move: Record<string, [number, number]> = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] };
    if (move[e.key]) { e.preventDefault(); autoFit.current = false; const [dx, dy] = move[e.key]; view.current = { ...view.current, x: view.current.x + dx, y: view.current.y + dy }; kick(); }
    else if (e.key === "+" || e.key === "=") zoomAt(1.3);
    else if (e.key === "-" || e.key === "−") zoomAt(1 / 1.3);
    else if (e.key === "0") fit();
  };

  // Vollbild über die Fullscreen-API; ohne sie (oder bei Ablehnung) füllt die Bühne per CSS das Fenster.
  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === stage.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  const toggleFull = async () => {
    const el = stage.current!;
    if (full) { if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined); setFull(false); }
    else { try { if (!el.requestFullscreen) throw new Error(tr("nicht unterstützt")); await el.requestFullscreen(); } catch { setFull(true); } }
    setTimeout(kick, 50);
  };
  useEffect(() => { if (!full) return; const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.fullscreenElement) setFull(false); }; window.addEventListener("keydown", esc); return () => window.removeEventListener("keydown", esc); }, [full]);

  const tip = hover ? nodes[hover.i] : undefined;
  return (
    <div ref={stage} className={`graph-stage${full ? " full" : ""}`}>
      <canvas ref={canvas} className="graph-canvas" role="img" aria-label={label} tabIndex={0}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={() => { drag.current = undefined; if (hoverRef.current >= 0) { hoverRef.current = -1; setHover(undefined); kick(); } }}
        onDoubleClick={onDoubleClick} onKeyDown={onKeyDown} />
      <p className="graph-hint small muted">{tr("Scrollen zum Zoomen, Ziehen zum Verschieben, Hover zum Erkunden, Klicken zum Auswählen")}</p>
      <div className="graph-actions">
        <button type="button" className="btn btn-s" onClick={() => zoomAt(1.3)} aria-label={tr("Vergrößern")}>+</button>
        <button type="button" className="btn btn-s" onClick={() => zoomAt(1 / 1.3)} aria-label={tr("Verkleinern")}>−</button>
        <button type="button" className="btn btn-s" onClick={fit}>{tr("Ansicht zurücksetzen")}</button>
        <button type="button" className="btn btn-s" aria-pressed={paused} onClick={() => setPaused((p) => !p)}>{paused ? tr("Weiter") : tr("Pause")}</button>
        <button type="button" className="btn btn-s" aria-pressed={full} onClick={() => void toggleFull()}>{full ? tr("Vollbild beenden") : tr("Vollbild")}</button>
        <button type="button" className="btn btn-s" onClick={onShare}>{tr("Teilen")}</button>
      </div>
      {shareNote && <p className="graph-share small" role="status">{shareNote}</p>}
      {tip && hover && (
        <div className="graph-tip" role="tooltip" style={{ left: Math.min(hover.x + 14, size.current.w - 260), top: hover.y + 14 }}>
          <p>{cut(tip.text ?? tip.label, 160)}</p>
          <p className="muted small mono">{[tip.date ? new Date(tip.date).toLocaleDateString("de-DE") : null, tip.context].filter(Boolean).join(" · ")}</p>
          {tip.entities.length > 0 && <p className="muted small">{cut(tip.entities.join(", "), 100)}</p>}
        </div>
      )}
      {children}
    </div>
  );
}
