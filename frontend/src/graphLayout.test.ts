import { describe, expect, it } from "vitest";
import { layout } from "./graphLayout";

const ring = (n: number) => ({ nodes: Array.from({ length: n }, (_, i) => ({ id: `n${i}` })), edges: Array.from({ length: n }, (_, i) => ({ source: `n${i}`, target: `n${(i + 1) % n}` })) });

describe("layout", () => {
  it("places every node inside the frame and counts connections", () => {
    const { nodes, edges } = ring(12);
    const p = layout(nodes, [...edges, { source: "n0", target: "n6" }]);
    expect(p).toHaveLength(12);
    for (const q of p) {
      expect(q.x).toBeGreaterThanOrEqual(0); expect(q.x).toBeLessThanOrEqual(1000);
      expect(q.y).toBeGreaterThanOrEqual(0); expect(q.y).toBeLessThanOrEqual(600);
    }
    expect(p[0].degree).toBe(3);
    expect(p[1].degree).toBe(2);
  });

  it("gives the same picture for the same input", () => {
    const { nodes, edges } = ring(20);
    expect(layout(nodes, edges)).toEqual(layout(nodes, edges));
  });

  it("keeps nodes apart, even without any connection", () => {
    const p = layout(Array.from({ length: 30 }, (_, i) => ({ id: `n${i}` })), []);
    let closest = Infinity;
    for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) closest = Math.min(closest, Math.hypot(p[i].x - p[j].x, p[i].y - p[j].y));
    expect(closest).toBeGreaterThan(8);
  });

  it("keeps nodes without connection out of the way: they sit in a strip below and do not squash the connected rest", () => {
    const { nodes, edges } = ring(30);
    const lone = Array.from({ length: 8 }, (_, i) => ({ id: `x${i}` }));
    const p = layout([...nodes, ...lone], edges);
    const linked = p.filter((q) => q.degree > 0), loose = p.filter((q) => q.degree === 0);
    expect(loose).toHaveLength(8);
    const bottom = Math.max(...linked.map((q) => q.y));
    expect(Math.min(...loose.map((q) => q.y))).toBeGreaterThan(bottom);
    expect(new Set(loose.map((q) => `${q.x},${q.y}`)).size).toBe(8); // keiner auf dem anderen
    // Ohne die Einzelnen sähe die Gruppe genauso breit aus wie mit ihnen: sie nimmt den Rahmen ein statt in einer Ecke zu kleben.
    const span = Math.max(...linked.map((q) => q.x)) - Math.min(...linked.map((q) => q.x));
    expect(span).toBeGreaterThan(300);
  });

  it("scales uniformly, so a chain stays a chain", () => {
    const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}` }));
    const p = layout(nodes, nodes.slice(1).map((_, i) => ({ source: `n${i}`, target: `n${i + 1}` })));
    const w = Math.max(...p.map((q) => q.x)) - Math.min(...p.map((q) => q.x)), h = Math.max(...p.map((q) => q.y)) - Math.min(...p.map((q) => q.y));
    expect(Math.max(w, h) / Math.max(Math.min(w, h), 1)).toBeGreaterThan(1.05);
  });

  it("handles empty input, one node, edges to unknown nodes and nodes on top of each other", () => {
    expect(layout([], [])).toEqual([]);
    expect(layout([{ id: "a" }], [])).toEqual([{ id: "a", x: 500, y: 300, degree: 0 }]);
    const p = layout([{ id: "a" }, { id: "b" }], [{ source: "a", target: "zzz" }, { source: "a", target: "a" }]);
    expect(p.map((q) => q.degree)).toEqual([0, 0]);
    expect(p.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y))).toBe(true);
  });
});
