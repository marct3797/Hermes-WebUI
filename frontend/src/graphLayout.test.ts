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

  it("handles empty input, one node, edges to unknown nodes and nodes on top of each other", () => {
    expect(layout([], [])).toEqual([]);
    expect(layout([{ id: "a" }], [])).toEqual([{ id: "a", x: 500, y: 300, degree: 0 }]);
    const p = layout([{ id: "a" }, { id: "b" }], [{ source: "a", target: "zzz" }, { source: "a", target: "a" }]);
    expect(p.map((q) => q.degree)).toEqual([0, 0]);
    expect(p.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y))).toBe(true);
  });
});
