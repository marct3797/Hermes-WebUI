/**
 * Kräfte-Layout für die Konstellation, ohne Bibliothek und ohne Zufall (gleiche Eingabe, gleiches Bild).
 * Abstoßung nur zwischen Knoten benachbarter Rasterzellen, Federn entlang der Kanten, leichte Schwerkraft zur Mitte:
 * ein Schritt kostet O(Knoten + Kanten), auch bei 1000 Knoten und 12000 Kanten.
 */
export type Sim = {
  n: number; x: Float64Array; y: Float64Array; vx: Float64Array; vy: Float64Array;
  ea: Int32Array; eb: Int32Array; k: Float64Array; deg: Int32Array; alpha: number;
};

const CELL = 70; // Reichweite der Abstoßung
const REST = 26; // Ruhelänge einer Feder
const GOLDEN = 2.399963229728653;
export const SETTLED = 0.02;

export function createSim(n: number): Sim {
  const s: Sim = { n, x: new Float64Array(n), y: new Float64Array(n), vx: new Float64Array(n), vy: new Float64Array(n),
    ea: new Int32Array(0), eb: new Int32Array(0), k: new Float64Array(0), deg: new Int32Array(n), alpha: 1 };
  const R = 24 * Math.sqrt(n);
  for (let i = 0; i < n; i++) { const r = R * Math.sqrt((i + 0.5) / n), a = i * GOLDEN; s.x[i] = r * Math.cos(a); s.y[i] = r * Math.sin(a); }
  return s;
}

/** Kanten (Indexpaare) setzen und neu erhitzen; die Positionen bleiben, damit ein Ausblenden die Karte nicht umwirft. */
export function setEdges(s: Sim, edges: Array<[number, number, number]>) {
  const m = edges.length;
  s.ea = new Int32Array(m); s.eb = new Int32Array(m); s.k = new Float64Array(m); s.deg.fill(0);
  edges.forEach(([a, b], i) => { s.ea[i] = a; s.eb[i] = b; s.deg[a]++; s.deg[b]++; });
  edges.forEach(([a, b, w], i) => { s.k[i] = (0.2 * Math.min(1, Math.max(0.2, w))) / Math.max(1, Math.min(s.deg[a], s.deg[b])); });
  s.alpha = 1;
}

export function step(s: Sim): void {
  const { n, x, y, vx, vy } = s;
  const cells = new Map<number, number[]>();
  const cx = new Int32Array(n), cy = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    cx[i] = Math.floor(x[i] / CELL); cy[i] = Math.floor(y[i] / CELL);
    const key = cx[i] * 100003 + cy[i];
    const c = cells.get(key);
    if (c) c.push(i); else cells.set(key, [i]);
  }
  for (let i = 0; i < n; i++) {
    for (let gx = -1; gx <= 1; gx++) for (let gy = -1; gy <= 1; gy++) {
      const c = cells.get((cx[i] + gx) * 100003 + cy[i] + gy);
      if (!c) continue;
      for (const j of c) {
        if (j <= i) continue;
        let dx = x[i] - x[j], dy = y[i] - y[j], d = Math.hypot(dx, dy);
        if (d >= CELL) continue;
        if (d < 0.01) { dx = ((i * 7 + j) % 5) - 2 || 1; dy = ((i + j * 3) % 5) - 2 || 1; d = Math.hypot(dx, dy); }
        const f = (1 - d / CELL) * 2.2 * s.alpha;
        vx[i] += (dx / d) * f; vy[i] += (dy / d) * f; vx[j] -= (dx / d) * f; vy[j] -= (dy / d) * f;
      }
    }
  }
  for (let e = 0; e < s.ea.length; e++) {
    const a = s.ea[e], b = s.eb[e];
    const dx = x[b] - x[a], dy = y[b] - y[a], d = Math.hypot(dx, dy) || 0.01;
    const f = (d - REST) * s.k[e];
    vx[a] += (dx / d) * f; vy[a] += (dy / d) * f; vx[b] -= (dx / d) * f; vy[b] -= (dy / d) * f;
  }
  for (let i = 0; i < n; i++) {
    vx[i] -= x[i] * 0.004; vy[i] -= y[i] * 0.004; // Schwerkraft: Einzelne treiben nicht davon
    vx[i] *= 0.82; vy[i] *= 0.82;
    const v = Math.hypot(vx[i], vy[i]);
    if (v > 14) { vx[i] *= 14 / v; vy[i] *= 14 / v; }
    x[i] += vx[i]; y[i] += vy[i];
  }
  s.alpha = Math.max(SETTLED / 2, s.alpha * 0.985);
}

export const settled = (s: Sim) => s.alpha <= SETTLED;

export type Box = { x0: number; y0: number; x1: number; y1: number };
export function bounds(s: Sim): Box {
  if (!s.n) return { x0: -1, y0: -1, x1: 1, y1: 1 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < s.n; i++) { x0 = Math.min(x0, s.x[i]); x1 = Math.max(x1, s.x[i]); y0 = Math.min(y0, s.y[i]); y1 = Math.max(y1, s.y[i]); }
  return { x0, y0, x1, y1 };
}

export type View = { x: number; y: number; k: number };
/** Bildschirm (Pixel im Zeichenfeld, Mitte = Ursprung der Ansicht) <-> Welt. */
export const toScreen = (v: View, w: number, h: number, x: number, y: number) => ({ x: w / 2 + v.x + x * v.k, y: h / 2 + v.y + y * v.k });

export function fitView(b: Box, w: number, h: number): View {
  const k = Math.min(3, Math.max(0.05, 0.9 * Math.min(w / Math.max(b.x1 - b.x0, 1), h / Math.max(b.y1 - b.y0, 1))));
  return { k, x: -((b.x0 + b.x1) / 2) * k, y: -((b.y0 + b.y1) / 2) * k };
}

/** Nächster Knoten unter dem Zeiger (Pixel) innerhalb von `reach` Pixeln, sonst -1. */
export function hitTest(s: Pick<Sim, "n" | "x" | "y">, v: View, w: number, h: number, px: number, py: number, reach = 9): number {
  let best = -1, bd = reach * reach;
  for (let i = 0; i < s.n; i++) {
    const p = toScreen(v, w, h, s.x[i], s.y[i]);
    const d = (p.x - px) ** 2 + (p.y - py) ** 2;
    if (d <= bd) { bd = d; best = i; }
  }
  return best;
}
