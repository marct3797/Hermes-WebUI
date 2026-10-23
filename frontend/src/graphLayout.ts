/** Kräftebasierte Anordnung eines kleinen Graphen (bis einige hundert Knoten) ohne Bibliothek: gleiche Eingabe, gleiches Bild. */
export type LayoutNode = { id: string };
export type LayoutEdge = { source: string; target: string };
export type Placed = { id: string; x: number; y: number; degree: number };

const PAD = 36;
const CELL = 22; // Raster für Knoten ohne Verbindung

type Pt = { x: number; y: number };

/** Kräfte auf den verbundenen Knoten. Das Bild behält sein Seitenverhältnis und wird in den Rahmen eingepasst und zentriert. */
function simulate(n: number, links: Array<[number, number]>, width: number, height: number, iterations: number): Pt[] {
  if (n === 1) return [{ x: width / 2, y: height / 2 }];
  // Start auf einem Kreis, leicht versetzt nach Index: bestimmt und ohne Überdeckung.
  const x = new Float64Array(n), y = new Float64Array(n), vx = new Float64Array(n), vy = new Float64Array(n);
  const r0 = Math.min(width, height) * 0.35;
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    x[i] = width / 2 + r0 * Math.cos(t) * (0.6 + 0.4 * ((i * 7) % 5) / 4);
    y[i] = height / 2 + r0 * Math.sin(t) * (0.6 + 0.4 * ((i * 3) % 5) / 4);
  }
  const k = Math.sqrt((width * height) / Math.max(n, 1)) * 0.7; // gewünschter Abstand
  for (let it = 0; it < iterations; it++) {
    const cool = 1 - it / iterations;
    for (let i = 0; i < n; i++) { vx[i] = 0; vy[i] = 0; }
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = x[i] - x[j], dy = y[i] - y[j];
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = (i - j) * 0.1; dy = 0.1; d2 = dx * dx + dy * dy; }
        const d = Math.sqrt(d2);
        const f = (k * k) / d2; // Abstoßung
        vx[i] += (dx / d) * f * d; vy[i] += (dy / d) * f * d;
        vx[j] -= (dx / d) * f * d; vy[j] -= (dy / d) * f * d;
      }
    }
    for (const [a, b] of links) {
      const dx = x[a] - x[b], dy = y[a] - y[b];
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d - k) * 0.08; // Feder
      vx[a] -= (dx / d) * f * d * 0.1; vy[a] -= (dy / d) * f * d * 0.1;
      vx[b] += (dx / d) * f * d * 0.1; vy[b] += (dy / d) * f * d * 0.1;
    }
    for (let i = 0; i < n; i++) {
      vx[i] += (width / 2 - x[i]) * 0.02; vy[i] += (height / 2 - y[i]) * 0.02; // Schwerkraft zur Mitte: hält getrennte Gruppen beieinander
      const m = Math.hypot(vx[i], vy[i]) || 1;
      const step = Math.min(m, 40 * cool + 1);
      x[i] += (vx[i] / m) * step; y[i] += (vy[i] / m) * step;
    }
  }
  const minX = Math.min(...x), maxX = Math.max(...x), minY = Math.min(...y), maxY = Math.max(...y);
  // Ein gemeinsamer Maßstab: eine Kette wird nicht quer durchs Bild gezogen, ein Haufen nicht plattgedrückt.
  const s = Math.min((width - 2 * PAD) / Math.max(maxX - minX, 1), (height - 2 * PAD) / Math.max(maxY - minY, 1));
  const offX = (width - 2 * PAD - (maxX - minX) * s) / 2, offY = (height - 2 * PAD - (maxY - minY) * s) / 2;
  return Array.from({ length: n }, (_, i) => ({ x: PAD + offX + (x[i] - minX) * s, y: PAD + offY + (y[i] - minY) * s }));
}

/**
 * Verbundene Knoten werden kräftebasiert angeordnet. Knoten ohne Verbindung gehören nicht in die Simulation (die Abstoßung
 * würde sie weit hinausschieben und den Rest auf einen Fleck stauchen): sie liegen als Raster am unteren Rand.
 */
export function layout(nodes: LayoutNode[], edges: LayoutEdge[], width = 1000, height = 600, iterations = 220): Placed[] {
  const n = nodes.length;
  if (n === 0) return [];
  const index = new Map(nodes.map((nd, i) => [nd.id, i]));
  const deg = new Array<number>(n).fill(0);
  const links: Array<[number, number]> = [];
  for (const e of edges) {
    const a = index.get(e.source), b = index.get(e.target);
    if (a === undefined || b === undefined || a === b) continue;
    links.push([a, b]); deg[a]++; deg[b]++;
  }
  const linked = nodes.flatMap((_, i) => (deg[i] > 0 ? [i] : []));
  const loose = nodes.flatMap((_, i) => (deg[i] === 0 ? [i] : []));
  const out = new Array<Placed>(n);
  const put = (i: number, p: Pt) => { out[i] = { id: nodes[i].id, x: p.x, y: p.y, degree: deg[i] }; };

  if (linked.length === 0 || loose.length === 0) {
    // Alles oder nichts verbunden: eine einzige Simulation (bei lauter Einzelnen verteilt die Abstoßung sie gleichmäßig).
    simulate(n, links, width, height, iterations).forEach((p, i) => put(i, p));
    return out;
  }
  const cols = Math.max(1, Math.floor((width - 2 * PAD) / CELL));
  const rows = Math.ceil(loose.length / cols);
  const strip = rows * CELL + PAD / 2;
  const local = new Map(linked.map((g, l) => [g, l]));
  const sub = links.map(([a, b]) => [local.get(a)!, local.get(b)!] as [number, number]);
  simulate(linked.length, sub, width, Math.max(height - strip, 120), iterations).forEach((p, l) => put(linked[l], p));
  const top = height - strip + CELL / 2;
  loose.forEach((g, i) => put(g, { x: PAD + (i % cols) * CELL, y: top + Math.floor(i / cols) * CELL }));
  return out;
}
