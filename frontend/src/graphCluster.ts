/**
 * Ordnet einen Wissensgraphen so, dass man ihn lesen kann. Ein echtes Gedächtnis liefert wenige hundert Knoten mit Tausenden
 * Kanten: Fakten, die dieselbe Entität nennen, hängen alle untereinander zusammen ("entity"), dazu zeitliche und inhaltliche
 * Nachbarn. Als Linien gezeichnet ist das ein Klumpen. Hier wird der Graph deshalb zuerst gelichtet und in Gruppen geteilt:
 *
 *  1. Jede Kante bekommt eine Stärke aus ihrem Typ und der Überlappung der Nachbarschaften (Jaccard). Fakten derselben
 *     Gruppe teilen viele Nachbarn, Fakten verschiedener Gruppen kaum.
 *  2. Aus den starken Kanten entstehen Gruppen (Louvain, ohne Zufall: gleiche Eingabe, gleiche Gruppen).
 *  3. Je Knoten bleiben seine stärksten Kanten als Gerüst, der Rest wird nicht gezeichnet.
 *
 * Reine Funktionen, ohne DOM.
 */
export type GNode = { id: string; label: string; kind?: string | null };
export type GEdge = { source: string; target: string; label?: string | null; weight?: number | null };

/** Wie viel eine Verbindung dieses Typs sagt: Ursachen und Ähnlichkeit mehr als bloße zeitliche Nähe. */
const TYPE_WEIGHT: Record<string, number> = { caused_by: 1.6, causes: 1.6, semantic: 1.2, entity: 1, temporal: 0.7 };
export const KEEP_PER_NODE = 3;
const MIN_GROUP = 3;

export type Link = { a: number; b: number; score: number; label: string | null };
export type Group = { id: number; members: number[]; hub: number; rank: number };
export type Analysis = {
  /** Anzahl aller Kanten je Knoten, wie geliefert. */
  degree: number[];
  /** Gerüst: die stärksten Kanten je Knoten, ohne Doppelte. */
  backbone: Link[];
  /** Stärke aller Kanten (Index a < b), für die Nachbarliste eines gewählten Knotens. */
  links: Link[];
  /** Gruppe je Knoten oder -1 für Knoten ohne Gruppe (einzeln oder ohne Verbindung). */
  group: number[];
  /** Gruppen nach Größe absteigend. `rank` bestimmt die Farbe. */
  groups: Group[];
};

const typeWeight = (label: string | null | undefined) => TYPE_WEIGHT[label ?? ""] ?? 1;

/** Louvain-Verfahren: Gruppen mit möglichst vielen starken Kanten innen. Knoten in fester Reihenfolge, Gleichstand zugunsten der kleineren Gruppe. */
export function louvain(n: number, edges: Array<[number, number, number]>): number[] {
  let adj: Array<Map<number, number>> = Array.from({ length: n }, () => new Map());
  for (const [a, b, w] of edges) {
    if (a === b || w <= 0) continue;
    adj[a].set(b, (adj[a].get(b) ?? 0) + w);
    adj[b].set(a, (adj[b].get(a) ?? 0) + w);
  }
  let members: number[][] = Array.from({ length: n }, (_, i) => [i]);
  for (let level = 0; level < 5; level++) {
    const size = adj.length;
    const strength = adj.map((m) => [...m.values()].reduce((s, w) => s + w, 0));
    const m2 = strength.reduce((s, k) => s + k, 0);
    if (m2 === 0) break;
    const comm = Array.from({ length: size }, (_, i) => i);
    const total = strength.slice();
    let moved = true;
    for (let pass = 0; moved && pass < 30; pass++) {
      moved = false;
      for (let i = 0; i < size; i++) {
        const toComm = new Map<number, number>();
        for (const [j, w] of adj[i]) if (j !== i) toComm.set(comm[j], (toComm.get(comm[j]) ?? 0) + w);
        total[comm[i]] -= strength[i];
        let best = comm[i];
        let bestGain = (toComm.get(best) ?? 0) - (total[best] * strength[i]) / m2;
        for (const [c, w] of toComm) {
          const gain = w - (total[c] * strength[i]) / m2;
          if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) <= 1e-12 && c < best)) { best = c; bestGain = gain; }
        }
        total[best] += strength[i];
        if (best !== comm[i]) { comm[i] = best; moved = true; }
      }
    }
    const ids = [...new Set(comm)].sort((x, y) => x - y);
    if (ids.length === size) break; // nichts mehr zusammengelegt
    const renum = new Map(ids.map((c, k) => [c, k]));
    const next: Array<Map<number, number>> = ids.map(() => new Map());
    const nextMembers: number[][] = ids.map(() => []);
    for (let i = 0; i < size; i++) {
      const ci = renum.get(comm[i])!;
      nextMembers[ci].push(...members[i]);
      for (const [j, w] of adj[i]) { const cj = renum.get(comm[j])!; next[ci].set(cj, (next[ci].get(cj) ?? 0) + w); }
    }
    adj = next; members = nextMembers;
  }
  const out = new Array<number>(n).fill(0);
  members.forEach((ms, g) => ms.forEach((i) => { out[i] = g; }));
  return out;
}

export function analyze(nodes: GNode[], edges: GEdge[]): Analysis {
  const n = nodes.length;
  const index = new Map(nodes.map((nd, i) => [nd.id, i]));
  // Je Knotenpaar die gewichtigste Verbindung; Doppelte und Schleifen fallen weg.
  const pair = new Map<number, { a: number; b: number; label: string | null; w: number }>();
  const degree = new Array<number>(n).fill(0);
  for (const e of edges) {
    const s = index.get(e.source), t = index.get(e.target);
    if (s === undefined || t === undefined || s === t) continue;
    const a = Math.min(s, t), b = Math.max(s, t), key = a * n + b;
    const w = typeWeight(e.label) * (typeof e.weight === "number" && e.weight > 0 ? e.weight : 1);
    const had = pair.get(key);
    if (!had) { pair.set(key, { a, b, label: e.label ?? null, w }); degree[a]++; degree[b]++; }
    else if (w > had.w) { had.w = w; had.label = e.label ?? null; }
  }
  const nb: Array<Set<number>> = Array.from({ length: n }, () => new Set());
  for (const { a, b } of pair.values()) { nb[a].add(b); nb[b].add(a); }

  const links: Link[] = [];
  for (const { a, b, label, w } of pair.values()) {
    let common = 0;
    const [small, large] = nb[a].size <= nb[b].size ? [nb[a], nb[b]] : [nb[b], nb[a]];
    for (const x of small) if (large.has(x)) common++;
    const union = nb[a].size + nb[b].size - common;
    const jaccard = union > 0 ? common / union : 0;
    links.push({ a, b, label, score: w * (0.15 + jaccard) });
  }
  links.sort((x, y) => y.score - x.score || x.a - y.a || x.b - y.b);

  // Gerüst: je Knoten die stärksten Kanten (eine Kante bleibt, wenn einer ihrer Knoten sie unter seinen besten hat).
  const taken = new Array<number>(n).fill(0);
  const backbone: Link[] = [];
  for (const l of links) {
    if (taken[l.a] < KEEP_PER_NODE || taken[l.b] < KEEP_PER_NODE) { backbone.push(l); taken[l.a]++; taken[l.b]++; }
  }

  // Gruppen aus allen gewichteten Kanten.
  const comm = louvain(n, links.map((l) => [l.a, l.b, l.score]));
  const bySize = new Map<number, number[]>();
  comm.forEach((c, i) => { if (degree[i] > 0) (bySize.get(c) ?? bySize.set(c, []).get(c)!).push(i); });
  const strength = new Array<number>(n).fill(0);
  for (const l of links) { strength[l.a] += l.score; strength[l.b] += l.score; }
  const real = [...bySize.values()].filter((m) => m.length >= MIN_GROUP).sort((x, y) => y.length - x.length || x[0] - y[0]);
  const group = new Array<number>(n).fill(-1);
  const groups: Group[] = real.map((ms, g) => {
    ms.forEach((i) => { group[i] = g; });
    const hub = ms.reduce((best, i) => (strength[i] > strength[best] ? i : best), ms[0]);
    return { id: g, members: ms, hub, rank: g };
  });
  return { degree, backbone, links, group, groups };
}
