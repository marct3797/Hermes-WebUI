import { describe, expect, it } from "vitest";
import type { RoomEvent, RoomMessage } from "./types";
import { mergeMessages, reduceRoom, type RoomState } from "./useRoom";

const base: RoomState = { messages: [], running: false, speaker: null, typing: {}, asks: [] };
const msg = (seq: number, author = "h/hermes/anna", text = `m${seq}`): RoomMessage => ({ seq, author, kind: "message", text, mentions: [], at: 1 });
const run = (events: RoomEvent[], from = base) => events.reduce(reduceRoom, from);

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

  it("collects asks per run and drops them once answered or the run ends", () => {
    const k = "h/hermes/anna";
    const ask = (run_id: string): RoomEvent => ({ type: "member.event", member: k, run_id, event: { type: "approval.requested", command: "rm x", reason: "", choices: ["once", "deny"], timeout_s: 300 } });
    let s = run([ask("r1"), ask("r1"), ask("r2")]);
    expect(s.asks.map((a) => a.runId)).toEqual(["r1", "r2"]);
    s = run([{ type: "member.event", member: k, run_id: "r1", event: { type: "approval.responded", choice: "once" } }], s);
    expect(s.asks.map((a) => a.runId)).toEqual(["r2"]);
    s = run([{ type: "member.event", member: k, run_id: "r2", event: { type: "run.failed", error: "x" } }], s);
    expect(s.asks).toEqual([]);
  });

  it("keeps clarify questions with their choices", () => {
    const s = run([{ type: "member.event", member: "k", run_id: "r1", event: { type: "clarify.requested", question: "Welche?", choices: ["a", "b"] } }]);
    expect(s.asks[0]).toMatchObject({ kind: "clarify", question: "Welche?", choices: ["a", "b"] });
  });

  it("finishing a turn resets the live state and remembers why", () => {
    const s = run([{ type: "turn.started", turn: "t" }, { type: "member.started", member: "k", round: 1 }, { type: "turn.finished", turn: "t", reason: "max_rounds" }]);
    expect(s).toMatchObject({ running: false, speaker: null, typing: {}, asks: [], finished: "max_rounds" });
  });

  it("takes the room state a reconnect reports", () => {
    expect(run([{ type: "state", running: true, speaker: "k" }])).toMatchObject({ running: true, speaker: "k" });
  });
});
