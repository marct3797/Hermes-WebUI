import { describe, expect, it } from "vitest";
import { analyze, KEEP_PER_NODE, louvain, type GEdge, type GNode } from "./graphCluster";
import { arrange } from "./graphLayout";

/** Ein Gedächtnis in Echtgröße: Fakten teilen sich Entitäten (dichte Gruppen), dazu zeitliche und inhaltliche Nachbarn. */
function memory(n: number, topics: number) {
  const nodes: GNode[] = Array.from({ length: n }, (_, i) => ({ id: `n${i}`, label: `Fakt ${i} zu Thema ${i % topics}`, kind: null }));
  const edges: GEdge[] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (i % topics === j % topics) edges.push({ source: `n${i}`, target: `n${j}`, label: "entity" });
  for (let i = 0; i < n; i++) for (const d of [1, 2, 3]) edges.push({ source: `n${i}`, target: `n${(i + d) % n}`, label: "temporal" });
  for (let i = 0; i < n; i += 5) edges.push({ source: `n${i}`, target: `n${(i * 7 + 3) % n}`, label: "semantic" });
  return { nodes, edges };
}

describe("louvain", () => {
  it("finds the two cliques joined by a single bridge", () => {
    const e: Array<[number, number, number]> = [];
    for (const base of [0, 5]) for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) e.push([base + i, base + j, 1]);
    e.push([4, 5, 1]);
    const c = louvain(10, e);
    expect(new Set(c.slice(0, 5)).size).toBe(1);
    expect(new Set(c.slice(5)).size).toBe(1);
    expect(c[0]).not.toBe(c[9]);
  });
});

describe("analyze", () => {
  it("turns a dense hairball into readable groups and a sparse backbone", () => {
    const { nodes, edges } = memory(150, 8);
    expect(edges.length).toBeGreaterThan(1500);
    const a = analyze(nodes, edges);
    expect(a.groups.length).toBeGreaterThanOrEqual(6);
    expect(a.groups.length).toBeLessThanOrEqual(12);
    // Gruppen entsprechen den Themen: Fakten desselben Themas landen in derselben Gruppe.
    const topicGroup = new Map<number, Set<number>>();
    nodes.forEach((_, i) => { const t = i % 8; (topicGroup.get(t) ?? topicGroup.set(t, new Set()).get(t)!).add(a.group[i]); });
    const pure = [...topicGroup.values()].filter((s) => s.size === 1).length;
    expect(pure).toBeGreaterThanOrEqual(6);
    // Gerüst: höchstens KEEP_PER_NODE je Knoten plus die Kanten, die der andere Endpunkt behalten wollte.
    expect(a.backbone.length).toBeLessThan(nodes.length * KEEP_PER_NODE);
    expect(a.backbone.length).toBeLessThan(edges.length / 4);
  });

  it("is deterministic and names a hub per group", () => {
    const { nodes, edges } = memory(60, 4);
    expect(analyze(nodes, edges)).toEqual(analyze(nodes, edges));
    for (const g of analyze(nodes, edges).groups) expect(g.members).toContain(g.hub);
  });

  it("puts nodes without a connection outside every group", () => {
    const a = analyze([{ id: "a", label: "a" }, { id: "b", label: "b" }, { id: "c", label: "c" }], []);
    expect(a.groups).toEqual([]);
    expect(a.group).toEqual([-1, -1, -1]);
  });

  it("ignores edges to unknown nodes, loops and duplicates", () => {
    const a = analyze([{ id: "a", label: "a" }, { id: "b", label: "b" }], [
      { source: "a", target: "b", label: "semantic" }, { source: "b", target: "a", label: "entity" },
      { source: "a", target: "a" }, { source: "a", target: "ghost" },
    ]);
    expect(a.links).toHaveLength(1);
    expect(a.degree).toEqual([1, 1]);
  });
});

describe("arrange", () => {
  const { nodes, edges } = memory(150, 8);
  const a = analyze(nodes, edges);
  const out = arrange(a, nodes.length);

  it("places every node inside the frame", () => {
    expect(out.nodes).toHaveLength(150);
    for (const p of out.nodes) {
      expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(1000);
      expect(p.y).toBeGreaterThanOrEqual(0); expect(p.y).toBeLessThanOrEqual(600);
    }
  });

  it("keeps the group bubbles apart", () => {
    for (let i = 0; i < out.groups.length; i++) for (let j = i + 1; j < out.groups.length; j++) {
      const d = Math.hypot(out.groups[i].x - out.groups[j].x, out.groups[i].y - out.groups[j].y);
      expect(d).toBeGreaterThan((out.groups[i].r + out.groups[j].r) * 0.95);
    }
  });

  it("keeps nodes of a group inside its bubble and apart from each other", () => {
    for (const p of out.nodes.filter((n) => n.group >= 0)) {
      const g = out.groups[p.group];
      expect(Math.hypot(p.x - g.x, p.y - g.y)).toBeLessThanOrEqual(g.r + 0.01);
    }
    const pts = out.nodes;
    let closest = Infinity;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) closest = Math.min(closest, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
    expect(closest).toBeGreaterThan(2);
  });

  it("is the same picture for the same input", () => {
    expect(arrange(analyze(nodes, edges), nodes.length)).toEqual(out);
  });

  it("lays out nodes without any connection as a grid", () => {
    const loose = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, label: `n${i}` }));
    const r = arrange(analyze(loose, []), loose.length);
    expect(r.nodes).toHaveLength(30);
    let closest = Infinity;
    for (let i = 0; i < 30; i++) for (let j = i + 1; j < 30; j++) closest = Math.min(closest, Math.hypot(r.nodes[i].x - r.nodes[j].x, r.nodes[i].y - r.nodes[j].y));
    expect(closest).toBeGreaterThan(4);
  });
});
