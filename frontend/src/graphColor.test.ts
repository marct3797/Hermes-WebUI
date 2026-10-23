import { describe, expect, it } from "vitest";
import real from "./fixtures/bff_graph_world.json";
import { colorNodes, linkColor, recencyColor } from "./graphColor";
import type { MemNode } from "./types";

const nodes = real.nodes as MemNode[];
const at = (d: string, over: Partial<MemNode> = {}): MemNode => ({ id: d, label: d, text: null, date: d, context: null, entities: [], kind: "world", ...over });

describe("recencyColor", () => {
  it("runs from blue (old) over purple to orange/red (new)", () => {
    expect(recencyColor(0)).toBe("rgb(79,140,255)");
    expect(recencyColor(0.5)).toBe("rgb(162,89,255)");
    expect(recencyColor(1)).toBe("rgb(255,77,77)");
    expect(recencyColor(-3)).toBe(recencyColor(0));
  });
});

describe("colorNodes mit den echten Daten", () => {
  it("colours the oldest fact blue and the newest red, with a date scale", () => {
    const c = colorNodes("recency", nodes);
    const ts = nodes.map((n) => Date.parse(n.date!));
    expect(c.scale).toEqual({ min: Math.min(...ts), max: Math.max(...ts) });
    expect(c.colors[ts.indexOf(Math.min(...ts))]).toBe(recencyColor(0));
    expect(c.colors[ts.indexOf(Math.max(...ts))]).toBe(recencyColor(1));
    expect(new Set(c.colors).size).toBeGreaterThan(3);
  });

  it("greys out facts without a date and survives a single date", () => {
    expect(colorNodes("recency", [at("2026-10-01"), at("x", { date: null })]).colors[1]).toBe("#6b7280");
    expect(colorNodes("recency", [at("2026-10-01"), at("2026-10-01")]).colors).toEqual([recencyColor(1), recencyColor(1)]);
    expect(colorNodes("recency", []).colors).toEqual([]);
  });

  it("colours by context, most frequent first, and by the most common entity of each node", () => {
    const ctx = colorNodes("context", nodes);
    expect(ctx.legend[0].count).toBeGreaterThanOrEqual(ctx.legend[1].count);
    expect(ctx.legend.map((l) => l.label)).toContain("Beispielkontext A");
    expect(ctx.legend.reduce((s, l) => s + l.count, 0)).toBe(nodes.length);
    const ent = colorNodes("entity", [at("a", { entities: ["Marc", "Hikari"] }), at("b", { entities: ["Hikari"] }), at("c", { entities: ["Hikari"] }), at("d", { entities: [] })]);
    expect(ent.legend[0]).toMatchObject({ label: "Hikari", count: 3 });
    expect(ent.colors[0]).toBe(ent.colors[1]);
    expect(ent.colors[3]).toBe("#6b7280");
  });

  it("colours by group", () => {
    const c = colorNodes("group", [at("a"), at("b"), at("c")], { of: [0, 0, -1], titles: ["Thema A"] });
    expect(c.colors[0]).toBe(c.colors[1]);
    expect(c.colors[2]).toBe("#6b7280");
    expect(c.legend[0].label).toBe("Thema A");
  });

  it("has fixed colours for the four link types", () => {
    expect(["semantic", "temporal", "entity", "causal"].map(linkColor)).toEqual(["#4f8cff", "#2dd4bf", "#ff9f43", "#a855f7"]);
    expect(linkColor("neu")).toBe("#9ca3af");
  });
});
