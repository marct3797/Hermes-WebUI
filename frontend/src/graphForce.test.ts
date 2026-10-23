import { describe, expect, it } from "vitest";
import { bounds, createSim, fitView, hitTest, setEdges, settled, step, toScreen } from "./graphForce";

/** Ein Gedächtnis in Echtgröße: Themen mit gemeinsamen Entitäten, zeitliche Nachbarn, Ähnlichkeiten. */
function memory(n: number, perNode: number): Array<[number, number, number]> {
  const e = new Map<string, [number, number, number]>();
  for (let i = 0; i < n; i++) for (let d = 1; d <= perNode / 2 && e.size < n * perNode / 1; d++) {
    const j = d <= 3 ? (i + d) % n : (i * 7 + d * 13) % n;
    if (j !== i) e.set(`${Math.min(i, j)}-${Math.max(i, j)}`, [i, j, 1 - (d % 7) / 10]);
  }
  return [...e.values()];
}

describe("graphForce", () => {
  it("is deterministic and never produces NaN", () => {
    const run = () => { const s = createSim(200); setEdges(s, memory(200, 12)); for (let i = 0; i < 150; i++) step(s); return s; };
    const a = run(), b = run();
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    expect([...a.x, ...a.y].every(Number.isFinite)).toBe(true);
  });

  it("copes with nodes on the same spot and with no edges", () => {
    const s = createSim(5);
    s.x.fill(3); s.y.fill(3);
    for (let i = 0; i < 50; i++) step(s);
    expect([...s.x, ...s.y].every(Number.isFinite)).toBe(true);
    expect(new Set(Array.from(s.x, (v, i) => `${v.toFixed(1)}/${s.y[i].toFixed(1)}`)).size).toBeGreaterThan(1);
  });

  it("pulls connected nodes together and calms down", () => {
    const s = createSim(40);
    setEdges(s, Array.from({ length: 19 }, (_, i) => [i, i + 1, 1] as [number, number, number]));
    const gap = () => Math.hypot(s.x[0] - s.x[19], s.y[0] - s.y[19]);
    const before = gap();
    for (let i = 0; i < 400; i++) step(s);
    expect(gap()).toBeLessThan(before);
    expect(settled(s)).toBe(true);
  });

  it("removing edges keeps the positions and heats the layout again", () => {
    const s = createSim(30);
    setEdges(s, memory(30, 6));
    for (let i = 0; i < 400; i++) step(s);
    const x0 = s.x[3];
    setEdges(s, memory(30, 2));
    expect(s.x[3]).toBe(x0);
    expect(settled(s)).toBe(false);
  });

  it("stays within the frame budget for 1000 nodes and 12000 edges (median of 15 steps under 16 ms)", () => {
    const edges = memory(1000, 24).slice(0, 12000);
    expect(edges.length).toBeGreaterThanOrEqual(11000);
    const s = createSim(1000);
    setEdges(s, edges);
    for (let i = 0; i < 20; i++) step(s);
    const t: number[] = [];
    for (let i = 0; i < 15; i++) { const a = performance.now(); step(s); t.push(performance.now() - a); }
    t.sort((a, b) => a - b);
    console.info(`Layout-Schritt 1000 Knoten / ${edges.length} Kanten: Median ${t[7].toFixed(2)} ms, max ${t[14].toFixed(2)} ms`);
    expect(t[7]).toBeLessThan(16);
  });

  it("fits the layout into the view and finds the node under the pointer", () => {
    const s = createSim(50);
    for (let i = 0; i < 100; i++) step(s);
    const v = fitView(bounds(s), 800, 500);
    for (let i = 0; i < s.n; i++) { const p = toScreen(v, 800, 500, s.x[i], s.y[i]); expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(800); expect(p.y).toBeGreaterThanOrEqual(0); expect(p.y).toBeLessThanOrEqual(500); }
    const p = toScreen(v, 800, 500, s.x[7], s.y[7]);
    expect(hitTest(s, v, 800, 500, p.x + 2, p.y - 2)).toBe(7);
    expect(hitTest(s, v, 800, 500, -500, -500)).toBe(-1);
  });
});
