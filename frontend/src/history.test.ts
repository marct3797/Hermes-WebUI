import { describe, expect, it } from "vitest";
import { argSummary, enrichTools, historyItems, toolResult } from "./history";
import type { Item } from "./types";

type Tool = Extract<Item, { kind: "tool" }>;
const live = (id: string, name: string, over: Partial<Tool> = {}): Tool => ({ kind: "tool", id, name, status: "ok", ...over });

describe("historyItems", () => {
  it("turns tool calls and tool messages into tool cards with arguments and output", () => {
    const items = historyItems({ data: [
      { role: "user", content: "Wo bin ich?", timestamp: 1792709556.5 },
      { role: "assistant", content: "Ich schaue nach.", reasoning: "Erst pwd.", tool_calls: [
        { id: "c1", type: "function", function: { name: "terminal", arguments: '{"command":"pwd\\nls"}' } },
      ] },
      { role: "tool", tool_call_id: "c1", tool_name: "terminal", content: '{"output":"/opt/data","exit_code":0}' },
      { role: "assistant", content: "Du bist in /opt/data." },
    ] });
    expect(items.map((i) => i.kind)).toEqual(["message", "message", "tool", "message"]);
    expect(items[0]).toMatchObject({ role: "user", at: 1792709556500 });
    expect(items[1]).toMatchObject({ role: "assistant", text: "Ich schaue nach.", reasoning: "Erst pwd." });
    expect(items[2]).toMatchObject({ id: "c1", name: "terminal", preview: "pwd", output: "/opt/data", status: "ok", enriched: true });
    expect((items[2] as Tool).args).toBe('{"command":"pwd\\nls"}');
  });

  it("keeps an assistant message that only holds reasoning and drops empty ones", () => {
    const items = historyItems([{ role: "assistant", content: null, reasoning_content: "denke" }, { role: "assistant", content: "" }]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ reasoning: "denke", text: "" });
  });

  it("pairs a tool message without call id with the oldest open call of the same name", () => {
    const items = historyItems([
      { role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "a.txt" } } }, { function: { name: "read_file", arguments: { path: "b.txt" } } }] },
      { role: "tool", tool_name: "read_file", content: "A" },
      { role: "tool", tool_name: "read_file", content: "B" },
    ]);
    expect(items.map((i) => i.kind === "tool" && [i.preview, i.output])).toEqual([["a.txt", "A"], ["b.txt", "B"]]);
  });

  it("shows an orphan tool message as its own card and marks a failing exit code", () => {
    const items = historyItems([{ role: "tool", tool_name: "terminal", content: '{"output":"nope","exit_code":2}' }]);
    expect(items[0]).toMatchObject({ kind: "tool", name: "terminal", status: "error", output: "nope\n[Exit-Code 2]" });
  });

  it("copes with unusual shapes", () => {
    expect(historyItems({ data: [null, 7, { role: "assistant", tool_calls: "x" }, { role: "assistant", tool_calls: [{}] }] })).toEqual([]);
  });
});

describe("toolResult and argSummary", () => {
  it("keeps plain text and cuts huge outputs", () => {
    expect(toolResult("hallo")).toEqual({ output: "hallo", failed: false });
    const big = toolResult("x".repeat(30_000));
    expect(big.output.length).toBeLessThan(20_100);
    expect(big.output.endsWith("(gekürzt)")).toBe(true);
  });
  it("reads the output out of JSON results", () => {
    expect(toolResult('{"stdout":"ok"}')).toEqual({ output: "ok", failed: false });
    expect(toolResult('{"error":"kaputt"}')).toMatchObject({ output: "kaputt", failed: true });
    expect(toolResult('{"andere":"form"}').output).toBe('{"andere":"form"}');
  });
  it("summarises arguments by their most telling parameter", () => {
    expect(argSummary({ path: "/a/b", mode: "r" })).toBe("/a/b");
    expect(argSummary({ n: 1 })).toBe('{"n":1}');
    expect(argSummary({})).toBeUndefined();
    expect(argSummary("ls -la\nrest")).toBe("ls -la");
  });
});

describe("enrichTools", () => {
  const hist: Item[] = [
    { kind: "tool", id: "c0", name: "terminal", args: '{"command":"alt"}', output: "alt", status: "ok", enriched: true },
    { kind: "tool", id: "c1", name: "terminal", args: '{"command":"pwd"}', output: "/opt", status: "ok", enriched: true },
    { kind: "tool", id: "c2", name: "read_file", args: '{"path":"a"}', output: "inhalt", status: "ok", enriched: true },
  ];

  it("adds arguments and output to the live cards, matched from the end by name and order", () => {
    const items: Item[] = [live("r:1", "terminal", { preview: "pwd + 4 commands" }), live("r:2", "read_file", { preview: "a" })];
    const next = enrichTools(items, hist);
    expect(next[0]).toMatchObject({ id: "r:1", preview: "pwd + 4 commands", args: '{"command":"pwd"}', output: "/opt", enriched: true });
    expect(next[1]).toMatchObject({ output: "inhalt", enriched: true });
  });

  it("leaves cards of earlier runs alone and returns the same array when nothing changes", () => {
    const done: Item[] = [live("x", "terminal", { enriched: true, output: "schon da" })];
    expect(enrichTools(done, hist)).toBe(done);
    expect(enrichTools([live("r:1", "terminal")], [])).toHaveLength(1);
  });

  it("waits for a result that is not in the history yet", () => {
    const pending: Item[] = [{ kind: "tool", id: "c9", name: "terminal", args: '{"command":"sleep"}', status: "ok", enriched: true }];
    const next = enrichTools([live("r:1", "terminal", { status: "running" })], pending);
    expect(next[0]).toMatchObject({ args: '{"command":"sleep"}', enriched: false });
    expect((next[0] as Tool).output).toBeUndefined();
  });
});
