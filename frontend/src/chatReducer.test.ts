import { describe, expect, it } from "vitest";
import { chatReducer, historyItems, initialState, sessionList } from "./chatReducer";
import type { ChatState, StreamEvent } from "./types";

const ev = (s: ChatState, e: StreamEvent) => chatReducer(s, { type: "event", event: e });

describe("chatReducer", () => {
  it("streams deltas into one assistant message and finishes it", () => {
    let s = chatReducer(initialState, { type: "user-sent", text: "hi", images: [] });
    s = ev(s, { type: "message.delta", text: "Hal" });
    s = ev(s, { type: "message.delta", text: "lo" });
    expect(s.items).toHaveLength(2);
    expect(s.items[1]).toMatchObject({ role: "assistant", text: "Hallo", streaming: true });
    s = ev(s, { type: "run.completed", usage: { input_tokens: 1, output_tokens: 2 } });
    expect(s.runStatus).toBe("done");
    expect(s.items[1]).toMatchObject({ streaming: false });
    expect(s.usage).toEqual({ input_tokens: 1, output_tokens: 2 });
  });

  it("keeps order: text, tool, text", () => {
    let s = ev(initialState, { type: "message.delta", text: "a" });
    s = ev(s, { type: "tool.started", id: "t", name: "terminal", preview: "ls" });
    s = ev(s, { type: "tool.completed", id: "t", name: "terminal", ok: true, duration_ms: 5, output: "x" });
    s = ev(s, { type: "message.delta", text: "b" });
    expect(s.items.map((i) => i.kind)).toEqual(["message", "tool", "message"]);
    expect(s.items[1]).toMatchObject({ status: "ok", durationMs: 5, output: "x", preview: "ls" });
  });

  it("marks running tools as failed when the run fails", () => {
    let s = ev(initialState, { type: "tool.started", id: "t", name: "x" });
    s = ev(s, { type: "run.failed", error: "boom" });
    expect(s.items[0]).toMatchObject({ status: "error" });
    expect(s.error).toBe("boom");
  });

  it("records approval decisions", () => {
    let s = ev(initialState, { type: "approval.requested", approval_id: "a", command: "rm", reason: "", timeout_s: 300 });
    const id = s.items[0].id;
    s = chatReducer(s, { type: "decided", id, decision: "deny" });
    expect(s.items[0]).toMatchObject({ decision: "deny" });
  });

  it("flags a lost connection only while running", () => {
    expect(chatReducer(initialState, { type: "connection-lost" }).runStatus).toBe("idle");
    const running = chatReducer(initialState, { type: "run-accepted", runId: "r" });
    expect(chatReducer(running, { type: "connection-lost" }).runStatus).toBe("lost");
  });
});

describe("parsers", () => {
  it("maps history, skipping tool roles and empty text", () => {
    const items = historyItems({ messages: [
      { role: "user", content: "a" }, { role: "tool", content: "x" }, { role: "assistant", content: [{ type: "text", text: "b" }] }, { role: "assistant", content: "" },
    ] });
    expect(items.map((i) => i.kind === "message" && i.text)).toEqual(["a", "b"]);
  });
  it("accepts several session list shapes", () => {
    expect(sessionList({ sessions: [{ id: "1", title: "T" }] })[0].title).toBe("T");
    expect(sessionList([{ id: "2" }])[0].title).toBe("Ohne Titel");
    expect(sessionList(null)).toEqual([]);
  });
});
