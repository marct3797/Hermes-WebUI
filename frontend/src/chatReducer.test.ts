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

  it("records approval decisions and keeps the choices the agent allows", () => {
    let s = ev(initialState, { type: "approval.requested", command: "rm", reason: "", timeout_s: 300, choices: ["once", "deny"], smart_denied: true });
    const id = s.items[0].id;
    expect(s.items[0]).toMatchObject({ kind: "approval", choices: ["once", "deny"], smartDenied: true });
    s = chatReducer(s, { type: "decided", id, decision: "deny" });
    expect(s.items[0]).toMatchObject({ decision: "deny" });
  });

  it("re-opens an approval card when the answer could not be sent, without failing the run", () => {
    let s = chatReducer(initialState, { type: "run-accepted", runId: "r" });
    s = ev(s, { type: "approval.requested", command: "x", reason: "", timeout_s: 300, choices: ["once", "always", "deny"] });
    const id = s.items[0].id;
    s = chatReducer(s, { type: "decided", id, decision: "always" });
    s = chatReducer(s, { type: "decision-failed", id });
    s = chatReducer(s, { type: "notice", error: "Bitte erneut anmelden", code: "step_up_required" });
    expect(s.items[0]).toMatchObject({ decision: undefined });
    expect(s).toMatchObject({ runStatus: "running", error: "Bitte erneut anmelden", errorCode: "step_up_required" });
  });

  it("closes the open approval when it was answered elsewhere", () => {
    let s = ev(initialState, { type: "approval.requested", command: "x", reason: "", timeout_s: 300, choices: ["once", "deny"] });
    s = ev(s, { type: "approval.responded", choice: "once", resolved: 1 });
    expect(s.items[0]).toMatchObject({ decision: "once" });
    expect(ev(s, { type: "approval.responded", choice: "deny" })).toBe(s); // nichts mehr offen
  });

  it("uses the final text when no deltas were streamed", () => {
    let s = chatReducer(initialState, { type: "user-sent", text: "hi", images: [] });
    s = ev(s, { type: "run.completed", text: "Antwort ohne Strom", usage: { total_tokens: 7 } });
    expect(s.items[1]).toMatchObject({ role: "assistant", text: "Antwort ohne Strom", streaming: false });
    // mit Strom wird der Text nicht doppelt angehängt
    let t = chatReducer(initialState, { type: "user-sent", text: "hi", images: [] });
    t = ev(t, { type: "message.delta", text: "Hallo" });
    t = ev(t, { type: "run.completed", text: "Hallo" });
    expect(t.items).toHaveLength(2);
  });

  it("ignores events it does not render yet", () => {
    const s = chatReducer(initialState, { type: "run-accepted", runId: "r" });
    expect(ev(s, { type: "run.steered", accepted: true })).toBe(s);
    expect(ev(s, { type: "unknown", name: "neu", data: {} })).toBe(s);
  });

  it("shows a subagent while it runs and closes it with the reported result", () => {
    let s = chatReducer(initialState, { type: "run-accepted", runId: "r" });
    s = ev(s, { type: "subagent.started", id: "w1", data: { goal: "Tests schreiben", model: "mock-small" } });
    s = ev(s, { type: "subagent.started", id: "w1", data: {} }); // doppelt gemeldet
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: "subagent", id: "w1", title: "Tests schreiben", status: "running", meta: ["mock-small"] });
    s = ev(s, { type: "subagent.completed", id: "w1", data: { duration_s: 12.5, input_tokens: 2400, output_tokens: 310, summary: "fertig" } });
    expect(s.items[0]).toMatchObject({ status: "ok", note: "fertig", meta: ["12,5 s", "2,4k ein · 310 aus"] });
    s = ev(s, { type: "subagent.completed", id: "w2", data: { status: "failed", error: "Zeitlimit" } });
    expect(s.items[1]).toMatchObject({ id: "w2", status: "error", note: "Zeitlimit", title: "Subagent" });
  });

  it("marks a steered message and reports a refused steer", () => {
    let s = chatReducer(initialState, { type: "user-sent", text: "hi", images: [] });
    s = chatReducer(s, { type: "run-accepted", runId: "r" });
    s = chatReducer(s, { type: "steered", text: "lieber kurz" });
    expect(s.items[1]).toMatchObject({ role: "user", text: "lieber kurz", mode: "steer" });
    expect(s.runStatus).toBe("running");
    expect(ev(s, { type: "run.steered", accepted: false }).error).toMatch(/nicht angenommen/);
  });

  it("keeps queued messages apart from the conversation until they are sent", () => {
    let s = chatReducer(initialState, { type: "queue-add", text: "danach bitte", images: [] });
    s = chatReducer(s, { type: "queue-add", text: "und das", images: ["data:image/png;base64,AA"] });
    expect(s.items).toHaveLength(0);
    expect(s.queued.map((q) => q.text)).toEqual(["danach bitte", "und das"]);
    s = chatReducer(s, { type: "queue-remove", id: s.queued[0].id });
    expect(s.queued.map((q) => q.text)).toEqual(["und das"]);
  });

  it("stamps approvals with the request and decision time", () => {
    let s = chatReducer(initialState, { type: "run-accepted", runId: "r" });
    s = ev(s, { type: "approval.requested", command: "rm -r build", reason: "", timeout_s: 300, choices: ["once", "deny"], smart_denied: true });
    const ask = s.items[0];
    expect(ask).toMatchObject({ kind: "approval", timeoutS: 300, smartDenied: true, choices: ["once", "deny"] });
    expect(ask.kind === "approval" && ask.at).toBeGreaterThan(0);
    s = ev(s, { type: "approval.responded", choice: "once" });
    expect(s.items[0].kind === "approval" && s.items[0].decidedAt).toBeGreaterThan(0);
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
  it("reads the history from a Hermes list object or a bare array", () => {
    const msgs = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }];
    expect(historyItems({ object: "list", data: msgs }).length).toBe(2);
    expect(historyItems(msgs).length).toBe(2);
    expect(historyItems(null)).toEqual([]);
  });
  it("accepts several session list shapes", () => {
    expect(sessionList({ sessions: [{ id: "1", title: "T" }] })[0].title).toBe("T");
    expect(sessionList([{ id: "2" }])[0].title).toBe("Ohne Titel");
    expect(sessionList(null)).toEqual([]);
  });
  it("reads the session list the way the real Hermes gateway sends it", () => {
    const list = sessionList({ object: "list", data: [
      { id: "a", title: "Erste", source: "cron", message_count: 4, last_active_at: 1_790_000_000, pinned: true },
      { id: "b", title: "Weg", archived: true },
    ], limit: 50, offset: 0, has_more: false });
    expect(list.map((x) => x.id)).toEqual(["a"]);
    expect(list[0]).toMatchObject({ source: "cron", messageCount: 4, pinned: true });
  });
});
