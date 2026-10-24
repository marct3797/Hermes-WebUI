import { describe, expect, it } from "vitest";
import { aggregate, fmtTokens, fmtUsd, sessionStats } from "./stats";

const NOON = new Date(2026, 9, 23, 12, 0, 0).getTime();
const at = (daysAgo: number, hour = 10) => new Date(2026, 9, 23 - daysAgo, hour, 0, 0).getTime() / 1000;
const row = (daysAgo: number, extra: Record<string, unknown> = {}) => ({
  started_at: at(daysAgo), source: "api_server", model: "muse", message_count: 4, tool_call_count: 2, api_call_count: 1,
  input_tokens: 1000, output_tokens: 200, cache_read_tokens: 0, reasoning_tokens: 50, estimated_cost_usd: 0, ...extra,
});

describe("sessionStats", () => {
  it("reads Hermes' session rows and skips rows without a time", () => {
    const s = sessionStats("delta", { data: [row(0, { ended_at: at(0) + 30, actual_cost_usd: 0.5, estimated_cost_usd: 0.4 }), { id: "x" }, null, "kaputt"] });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ agent: "delta", durationMs: 30_000, input: 1000, output: 200, toolCalls: 2, cost: 0.5, source: "api_server" });
  });
  it("accepts plain lists and the older `sessions` shape, and survives garbage", () => {
    expect(sessionStats("a", [row(1)])).toHaveLength(1);
    expect(sessionStats("a", { sessions: [{ updated_at: 1_790_000_000 }] })[0]).toMatchObject({ source: "unbekannt", model: "unbekannt", input: 0 });
    expect(sessionStats("a", null)).toEqual([]);
    expect(sessionStats("a", { data: "nein" })).toEqual([]);
  });
});

describe("aggregate", () => {
  const stats = [
    ...sessionStats("delta", { data: [row(0), row(0, { input_tokens: 4000, cache_read_tokens: 6000, source: "cron", model: "kimi" }), row(3), row(40)] }),
    ...sessionStats("gamma", { data: [row(1, { input_tokens: 500, output_tokens: 100, estimated_cost_usd: 1.25 })] }),
  ];

  it("counts only the chosen number of calendar days, today included", () => {
    const u = aggregate(stats, 7, NOON);
    expect(u.totals.sessions).toBe(4); // die Session von vor 40 Tagen zählt nicht
    expect(u.days).toHaveLength(7);
    expect(u.days.at(-1)).toMatchObject({ sessions: 2, tokens: 1200 + 4200 });
    expect(u.days[5].sessions).toBe(1); // gestern: gamma
    expect(u.days.reduce((n, d) => n + d.sessions, 0)).toBe(4);
  });

  it("sums totals, ranks agents by tokens and models by tokens, and reads the cache share", () => {
    const u = aggregate(stats, 7, NOON);
    expect(u.totals).toMatchObject({ toolCalls: 8, input: 1000 + 4000 + 1000 + 500, cacheRead: 6000, cost: 1.25 });
    expect(u.byAgent.map((a) => a.agent)).toEqual(["delta", "gamma"]);
    expect(u.byModel[0]).toMatchObject({ model: "kimi", sessions: 1 }); // 4 200 Tokens vor 3 × muse zusammen 3 100
    expect(u.bySource).toEqual([{ source: "api_server", sessions: 3 }, { source: "cron", sessions: 1 }]);
    expect(u.cacheShare).toBeCloseTo(6000 / (6500 + 6000), 5);
  });

  it("has no cache share without cache reads and shows empty days", () => {
    const u = aggregate(sessionStats("a", { data: [row(0)] }), 14, NOON);
    expect(u.cacheShare).toBeUndefined();
    expect(u.days).toHaveLength(14);
    expect(u.days.filter((d) => d.sessions === 0)).toHaveLength(13);
    expect(aggregate([], 14, NOON).totals.sessions).toBe(0);
  });
});

describe("formatting", () => {
  it("shortens big token counts in German format", () => {
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(1234)).toBe("1.234");
    expect(fmtTokens(12_345)).toBe("12,3 k");
    expect(fmtTokens(4_560_000)).toBe("4,56 M");
    expect(fmtUsd(1.5)).toBe("1,50 $");
  });
});
