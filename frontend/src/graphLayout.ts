/**
 * Legt einen analysierten Graphen (graphCluster.ts) in einen Rahmen: Gruppen als Blasen, darin die Knoten, Hub in der Mitte.
 * Ohne Bibliothek und ohne Zufall: gleiche Eingabe, gleiches Bild.
 */
import type { Analysis } from "./graphCluster";

export type PlacedNode = { index: number; x: number; y: number; group: number };
export type PlacedGroup = { id: number; x: number; y: number; r: number };
export type Arranged = { nodes: PlacedNode[]; groups: PlacedGroup[]; frame: { width: number; height: number } };

const PAD = 40;
const SPACING = 15; // Abstand der Knoten innerhalb einer Gruppe
const GAP = 26; // Abstand zwischen den Blasen
const GOLDEN = 2.399963229728653;

type Pt = { x: number; y: number };

/** Knoten einer Gruppe: Hub in der Mitte, der Rest als Sonnenblumenspirale; kurze Feder-Runde entlang der Gerüstkanten. */
function fillGroup(members: number[], strength: number[], links: Array<[number, number]>): { pos: Map<number, Pt>; r: number } {
  const order = members.slice().sort((a, b) => strength[b] - strength[a] || a - b);
  const n = order.length;
  const r = Math.max(SPACING * 1.6, SPACING * Math.sqrt(n / 0.55) * 0.62 + SPACING);
  const px = new Float64Array(n), py = new Float64Array(n);
  order.forEach((_, i) => {
    const rad = r * 0.86 * Math.sqrt((i + 0.5) / n), ang = i * GOLDEN;
    px[i] = rad * Math.cos(ang); py[i] = rad * Math.sin(ang);
  });
  const at = new Map(order.map((m, i) => [m, i]));
  const pairs = links.flatMap(([a, b]) => (at.has(a) && at.has(b) ? [[at.get(a)!, at.get(b)!] as [number, number]] : []));
  for (let it = 0; it < 80; it++) {
    const fx = new Float64Array(n), fy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = px[i] - px[j], dy = py[i] - py[j], d = Math.hypot(dx, dy) || 0.01;
        if (d < SPACING) { const f = (SPACING - d) / 2; fx[i] += (dx / d) * f; fy[i] += (dy / d) * f; fx[j] -= (dx / d) * f; fy[j] -= (dy / d) * f; }
      }
    }
    for (const [a, b] of pairs) {
      const dx = px[a] - px[b], dy = py[a] - py[b], d = Math.hypot(dx, dy) || 0.01;
      const f = (d - SPACING * 1.4) * 0.04;
      fx[a] -= (dx / d) * f; fy[a] -= (dy / d) * f; fx[b] += (dx / d) * f; fy[b] += (dy / d) * f;
    }
    for (let i = 0; i < n; i++) {
      px[i] += fx[i]; py[i] += fy[i];
      const d = Math.hypot(px[i], py[i]), lim = r * 0.9;
      if (d > lim) { px[i] *= lim / d; py[i] *= lim / d; }
    }
  }
  return { pos: new Map(order.map((m, i) => [m, { x: px[i], y: py[i] }])), r };
}

export function arrange(a: Analysis, count: number, width = 1000, height = 600): Arranged {
  const strength = new Array<number>(count).fill(0);
  for (const l of a.links) { strength[l.a] += l.score; strength[l.b] += l.score; }
  const backbone = a.backbone.map((l) => [l.a, l.b] as [number, number]);

  const filled = a.groups.map((g) => fillGroup(g.members, strength, backbone));
  const loose = Array.from({ length: count }, (_, i) => i).filter((i) => a.group[i] < 0);

  // Blasen anordnen: Start auf einem Kreis (große zuerst), dann anziehen entlang der Verbindungen und auseinanderschieben.
  const G = a.groups.length;
  const cx = new Float64Array(G), cy = new Float64Array(G);
  const rr = filled.map((f) => f.r);
  const total = rr.reduce((s, r) => s + r + GAP, 0);
  const ring = Math.max(total / (2 * Math.PI), 1);
  rr.forEach((_, g) => { const t = (2 * Math.PI * g) / Math.max(G, 1); cx[g] = ring * Math.cos(t); cy[g] = ring * Math.sin(t); });
  const bridge = new Map<number, number>();
  for (const l of a.links) {
    const ga = a.group[l.a], gb = a.group[l.b];
    if (ga >= 0 && gb >= 0 && ga !== gb) { const k = Math.min(ga, gb) * G + Math.max(ga, gb); bridge.set(k, (bridge.get(k) ?? 0) + l.score); }
  }
  const maxBridge = Math.max(1e-9, ...bridge.values());
  for (let it = 0; it < 300; it++) {
    const fx = new Float64Array(G), fy = new Float64Array(G);
    for (let g = 0; g < G; g++) {
      for (let h = g + 1; h < G; h++) {
        const dx = cx[g] - cx[h], dy = cy[g] - cy[h], d = Math.hypot(dx, dy) || 0.01, want = rr[g] + rr[h] + GAP;
        const pull = (bridge.get(g * G + h) ?? 0) / maxBridge;
        const f = d < want ? (want - d) * 0.5 : -pull * 0.02 * (d - want); // überlappen: auseinander; sonst Verbundene näher heran
        fx[g] += (dx / d) * f; fy[g] += (dy / d) * f; fx[h] -= (dx / d) * f; fy[h] -= (dy / d) * f;
      }
      fx[g] -= cx[g] * 0.01; fy[g] -= cy[g] * 0.01;
    }
    for (let g = 0; g < G; g++) { cx[g] += fx[g]; cy[g] += fy[g]; }
  }

  // Der Rahmen ist breiter als hoch: die Mitten der Blasen entsprechend auseinanderziehen (das vergrößert nur Abstände).
  if (G > 1) {
    const ext = (c: Float64Array) => [Math.min(...Array.from(c, (v, g) => v - rr[g])), Math.max(...Array.from(c, (v, g) => v + rr[g]))];
    const [x0, x1] = ext(cx), [y0, y1] = ext(cy);
    const sx = Math.min(2, Math.max(1, width / height / Math.max((x1 - x0) / Math.max(y1 - y0, 1), 0.1)));
    for (let g = 0; g < G; g++) cx[g] *= sx;
  }

  const nodes: PlacedNode[] = [];
  const groups: PlacedGroup[] = [];
  const place = (i: number, x: number, y: number, group: number) => nodes.push({ index: i, x, y, group });
  a.groups.forEach((g, gi) => {
    groups.push({ id: g.id, x: cx[gi], y: cy[gi], r: rr[gi] });
    for (const m of g.members) { const p = filled[gi].pos.get(m)!; place(m, cx[gi] + p.x, cy[gi] + p.y, gi); }
  });

  // Ohne Gruppe: ein Raster unter den Blasen.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const g of groups) { minX = Math.min(minX, g.x - g.r); maxX = Math.max(maxX, g.x + g.r); minY = Math.min(minY, g.y - g.r); maxY = Math.max(maxY, g.y + g.r); }
  if (!groups.length) { minX = 0; maxX = width - 2 * PAD; minY = 0; maxY = 0; }
  const cols = Math.max(1, Math.floor((Math.max(maxX - minX, width / 2)) / SPACING));
  loose.forEach((i, k) => place(i, minX + (k % cols) * SPACING, maxY + GAP + Math.floor(k / cols) * SPACING, -1));
  if (loose.length) maxY += GAP + Math.ceil(loose.length / cols) * SPACING;
  if (loose.length && !groups.length) maxX = minX + cols * SPACING;

  // Einheitlicher Maßstab in den Rahmen.
  const s = Math.min((width - 2 * PAD) / Math.max(maxX - minX, 1), (height - 2 * PAD) / Math.max(maxY - minY, 1));
  const offX = PAD + (width - 2 * PAD - (maxX - minX) * s) / 2, offY = PAD + (height - 2 * PAD - (maxY - minY) * s) / 2;
  const fit = (x: number, y: number): Pt => ({ x: offX + (x - minX) * s, y: offY + (y - minY) * s });
  return {
    nodes: nodes.map((n) => ({ ...n, ...fit(n.x, n.y) })),
    groups: groups.map((g) => ({ ...g, ...fit(g.x, g.y), r: g.r * s })),
    frame: { width, height },
  };
}
