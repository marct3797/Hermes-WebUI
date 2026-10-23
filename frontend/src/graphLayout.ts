/** Kräftebasierte Anordnung eines kleinen Graphen (bis einige hundert Knoten) ohne Bibliothek: gleiche Eingabe, gleiches Bild. */
export type LayoutNode = { id: string };
export type LayoutEdge = { source: string; target: string };
export type Placed = { id: string; x: number; y: number; degree: number };

const SMALL = 10;

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
      vx[i] += (width / 2 - x[i]) * 0.012; vy[i] += (height / 2 - y[i]) * 0.012; // Schwerkraft zur Mitte
      const m = Math.hypot(vx[i], vy[i]) || 1;
      const step = Math.min(m, 40 * cool + 1);
      x[i] += (vx[i] / m) * step; y[i] += (vy[i] / m) * step;
    }
  }
  // In den Rahmen skalieren, damit nichts am Rand abgeschnitten wird.
  const minX = Math.min(...x), maxX = Math.max(...x), minY = Math.min(...y), maxY = Math.max(...y);
  const pad = 36;
  let sx = (width - 2 * pad) / Math.max(maxX - minX, 1), sy = (height - 2 * pad) / Math.max(maxY - minY, 1);
  // Kleine Graphen behalten ihre Form (sonst wird eine Kette quer durchs Bild gezogen), große füllen den Rahmen.
  if (n < SMALL) sx = sy = Math.min(sx, sy);
  const offX = (width - 2 * pad - (maxX - minX) * sx) / 2, offY = (height - 2 * pad - (maxY - minY) * sy) / 2;
  return nodes.map((nd, i) => ({
    id: nd.id, degree: deg[i],
    x: n === 1 ? width / 2 : pad + offX + (x[i] - minX) * sx,
    y: n === 1 ? height / 2 : pad + offY + (y[i] - minY) * sy,
  }));
}
