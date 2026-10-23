import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { api } from "./api";
import { useRoom } from "./useRoom";
import type { RoomAsk, RoomEvent, RoomMessage } from "./types";
import { mergeMessages, reduceRoom, type RoomState } from "./useRoom";

const base: RoomState = { messages: [], running: false, speaker: null, typing: {}, asks: [] };
const msg = (seq: number, author = "h/hermes/anna", text = `m${seq}`): RoomMessage => ({ seq, author, kind: "message", text, mentions: [], at: 1 });
const run = (events: RoomEvent[], from = base) => events.reduce(reduceRoom, from);

describe("room paging recovery", () => {
  it("opens latest, loads older, then catches up all pages without jumping to a live message", async () => {
    let stream: { onmessage?: (m: { data: string }) => void } = {};
    vi.stubGlobal("EventSource", class { constructor() { stream = this; } onmessage?: (m: { data: string }) => void; close() {} });
    const page = (start: number, end: number, extra = {}) => ({ id: "r", messages: Array.from({ length: end - start + 1 }, (_, i) => msg(start + i)), running: false, speaker: null, has_older: start > 1, next_before: start, next_after: end, has_more: false, ...extra });
    vi.spyOn(api, "room").mockResolvedValue(page(406, 605) as never);
    const fetcher = vi.fn(async (url: string) => {
      const query = new URL(url, "http://localhost").searchParams;
      const after = Number(query.get("after"));
      const data = query.has("before") ? page(206, 405) : after === 605 ? page(606, 805, { has_more: true }) : page(806, 1010);
      return { ok: true, json: async () => data };
    });
    vi.stubGlobal("fetch", fetcher);
    const { result, unmount } = renderHook(() => useRoom("r"));
    await waitFor(() => expect(result.current.state.messages).toHaveLength(200));
    await act(async () => { await result.current.loadOlder(); });
    expect(result.current.state.messages[0].seq).toBe(206);
    act(() => { stream.onmessage?.({ data: JSON.stringify({ type: "message", message: msg(1010) }) }); stream.onmessage?.({ data: JSON.stringify({ type: "state", running: false, speaker: null }) }); });
    await waitFor(() => expect(result.current.state.messages).toHaveLength(805));
    expect(fetcher.mock.calls.map(([url]) => url)).toContain("/bff/rooms/r?after=805");
    unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
});

describe("mergeMessages", () => {
  it("sorts by seq and drops duplicates, the newer copy wins", () => {
    const out = mergeMessages([msg(2), msg(1)], [msg(2, "x", "neu"), msg(3)]);
    expect(out.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(out[1].text).toBe("neu");
  });
});

describe("reduceRoom", () => {
  it("shows a member typing from the first delta until their message arrives", () => {
    const k = "h/hermes/anna";
    let s = run([{ type: "turn.started", turn: "t" }, { type: "member.started", member: k, round: 1 }]);
    expect(s.running && s.speaker === k && s.typing[k].text === "").toBe(true);
    s = run([
      { type: "member.event", member: k, run_id: "r1", event: { type: "tool.started", id: "t1", name: "terminal" } },
      { type: "member.event", member: k, run_id: "r1", event: { type: "message.delta", text: "Hal" } },
      { type: "member.event", member: k, run_id: "r1", event: { type: "message.delta", text: "lo" } },
    ], s);
    expect(s.typing[k]).toEqual({ text: "Hallo", tool: "terminal" });
    s = run([{ type: "message", message: msg(1, k, "Hallo") }], s);
    expect(s.typing[k]).toBeUndefined();
    expect(s.messages).toHaveLength(1);
  });

  it("does not duplicate a message that history and stream both deliver", () => {
    const s = run([{ type: "message", message: msg(1) }, { type: "message", message: msg(1) }]);
    expect(s.messages).toHaveLength(1);
  });

  it("clears the typing row of a member who passes", () => {
    const k = "h/hermes/anna";
    const s = run([{ type: "member.started", member: k, round: 1 }, { type: "member.passed", member: k }]);
    expect(s.typing).toEqual({});
  });

  it("takes the open asks the server reports, as a whole list each time", () => {
    const k = "h/hermes/anna";
    const approval = (run_id: string): RoomAsk => ({ kind: "approval", member: k, run_id, command: "rm x", reason: "", choices: ["once", "deny"], timeout_s: 300, at: 1 });
    let s = run([{ type: "asks", asks: [approval("r1"), approval("r2")] }]);
    expect(s.asks.map((a) => a.runId)).toEqual(["r1", "r2"]);
    expect(s.asks[0]).toMatchObject({ kind: "approval", member: k, command: "rm x", choices: ["once", "deny"] });
    s = run([{ type: "asks", asks: [approval("r2")] }], s);
    expect(s.asks.map((a) => a.runId)).toEqual(["r2"]);
    s = run([{ type: "asks", asks: [] }], s);
    expect(s.asks).toEqual([]);
  });

  it("does not guess asks from the run's own events any more, the server decides", () => {
    const s = run([{ type: "member.event", member: "k", run_id: "r1", event: { type: "approval.requested", command: "rm x", reason: "", choices: ["once"], timeout_s: 300 } }]);
    expect(s.asks).toEqual([]);
  });

  it("keeps clarify questions with their choices", () => {
    const s = run([{ type: "asks", asks: [{ kind: "clarify", member: "k", run_id: "r1", clarify_id: "c1", question: "Welche?", choices: ["a", "b"], at: 1 }] }]);
    expect(s.asks[0]).toMatchObject({ kind: "clarify", runId: "r1", clarifyId: "c1", question: "Welche?", choices: ["a", "b"] });
  });

  it("finishing a turn resets the live state and remembers why", () => {
    const s = run([{ type: "turn.started", turn: "t" }, { type: "member.started", member: "k", round: 1 }, { type: "turn.finished", turn: "t", reason: "max_rounds" }]);
    expect(s).toMatchObject({ running: false, speaker: null, typing: {}, asks: [], finished: "max_rounds" });
  });

  it("takes the room state a reconnect reports", () => {
    expect(run([{ type: "state", running: true, speaker: "k", asks: [] }])).toMatchObject({ running: true, speaker: "k" });
  });

  it("brings a waiting approval back when the page reconnects", () => {
    const ask: RoomAsk = { kind: "approval", member: "k", run_id: "r1", command: "ls", reason: "", choices: ["once"], at: 1 };
    expect(run([{ type: "state", running: true, speaker: "k", asks: [ask] }]).asks).toHaveLength(1);
  });
});
