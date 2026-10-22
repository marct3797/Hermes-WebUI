import { describe, expect, it, vi } from "vitest";
import { activityByAgent, liveRuns, needs } from "./attention";
import { convKey, createRunStore } from "./runStore";
import type { AgentRef, StreamEvent } from "./types";

const A: AgentRef = { host: "hikari", runtime: "hermes", agent: "raiden" };
const B: AgentRef = { host: "hikari", runtime: "hermes", agent: "sora" };

class FakeES {
  static all: FakeES[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeES.all.push(this); }
  close() { this.closed = true; }
  emit(ev: StreamEvent) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(ev) })); }
}

function setup(over: Record<string, unknown> = {}) {
  FakeES.all = [];
  let n = 0;
  const api = {
    startRun: vi.fn(async (_a: AgentRef, body: { session_id?: string }) => ({ run_id: `run_${++n}`, session_id: body.session_id ?? `s${n}` })),
    eventsUrl: (a: AgentRef, rid: string) => `/events/${a.agent}/${rid}`,
    messages: vi.fn(async () => ({ messages: [{ role: "user", content: "alt" }, { role: "assistant", content: "Antwort" }] })),
    runStatus: vi.fn(async () => ({ status: "running" })),
    approve: vi.fn(async () => ({})),
    clarify: vi.fn(async () => ({})),
    steer: vi.fn(async () => ({})),
    stop: vi.fn(async () => ({})),
    ...over,
  };
  const store = createRunStore({ api: api as never, eventSource: (u) => new FakeES(u) as unknown as EventSource });
  return { store, api };
}
const last = () => FakeES.all[FakeES.all.length - 1];
const conv = (store: ReturnType<typeof setup>["store"], a: AgentRef, sid?: string) => store.getSnapshot().convs.get(convKey(a, sid));

describe("run store", () => {
  it("moves a new chat to its session id and keeps streaming into it", async () => {
    const { store } = setup();
    const onSession = vi.fn();
    await store.send(A, undefined, "hallo", [], { onSession });
    expect(onSession).toHaveBeenCalledWith("s1");
    expect(conv(store, A)).toBeUndefined();
    last().emit({ type: "message.delta", text: "Hi" });
    expect(conv(store, A, "s1")?.state.items.at(-1)).toMatchObject({ role: "assistant", text: "Hi" });
    expect(conv(store, A, "s1")?.sessionId).toBe("s1");
  });

  it("keeps a run alive while no view is open and reports what needs the person", async () => {
    const { store, api } = setup();
    await store.send(A, undefined, "räum auf", []);
    last().emit({ type: "tool.started", id: "t", name: "terminal", preview: "rm -r build" });
    last().emit({ type: "approval.requested", command: "rm -r build", reason: "räumt auf", choices: ["once", "deny"], timeout_s: 300 });
    store.open(A, "s1"); // eine Ansicht öffnet sich: lädt den Verlauf nicht über den laufenden Run
    expect(api.messages).not.toHaveBeenCalled();

    const snap = store.getSnapshot();
    expect(needs(snap)).toHaveLength(1);
    expect(needs(snap)[0]).toMatchObject({ kind: "approval", topic: "räum auf", agent: A });
    expect(liveRuns(snap)[0]).toMatchObject({ waiting: "approval", activity: "wartet auf Freigabe" });
    expect(activityByAgent(snap).get("hikari/hermes/raiden")).toMatchObject({ running: 1, waiting: 1 });

    const id = needs(snap)[0].id.split(":").slice(1).join(":");
    await store.decide("hikari/hermes/raiden#s1", id, "once");
    expect(api.approve).toHaveBeenCalledWith(A, "run_1", "once");
    expect(needs(store.getSnapshot())).toHaveLength(0);
    expect(store.getSnapshot().log[0].text).toBe("rm -r build · einmal erlaubt");
  });

  it("reopens the approval when the answer could not be sent", async () => {
    const { store } = setup({ approve: vi.fn(async () => { throw new Error("Step-up nötig"); }) });
    await store.send(A, undefined, "x", []);
    last().emit({ type: "approval.requested", command: "ls", reason: "", choices: ["once", "deny"], timeout_s: 300 });
    const n = needs(store.getSnapshot())[0];
    await store.decide(n.convKey, n.id.slice(n.convKey.length + 1), "once");
    expect(needs(store.getSnapshot())).toHaveLength(1);
    expect(conv(store, A, "s1")?.state.error).toBe("Step-up nötig");
    expect(store.getSnapshot().log).toHaveLength(0);
  });

  it("loads the history of an unknown session once and then keeps the streamed state", async () => {
    const { store, api } = setup();
    store.open(A, "alt");
    store.open(A, "alt");
    await vi.waitFor(() => expect(conv(store, A, "alt")).toBeDefined());
    expect(api.messages).toHaveBeenCalledTimes(1);
    expect(conv(store, A, "alt")?.state.items.map((i) => i.kind === "message" && i.text)).toEqual(["alt", "Antwort"]);

    await store.send(A, "alt", "weiter", []);
    last().emit({ type: "tool.started", id: "t", name: "terminal" });
    last().emit({ type: "run.completed" });
    store.open(A, "alt"); // zurück in die Ansicht: Tool-Zeilen bleiben, kein neuer Abruf
    expect(api.messages).toHaveBeenCalledTimes(1);
    expect(conv(store, A, "alt")?.state.items.some((i) => i.kind === "tool")).toBe(true);
  });

  it("retries a history load that failed", async () => {
    const messages = vi.fn().mockRejectedValueOnce(new Error("502")).mockResolvedValue({ messages: [{ role: "user", content: "ok" }] });
    const { store } = setup({ messages });
    store.open(A, "s9");
    await vi.waitFor(() => expect(conv(store, A, "s9")?.stale).toBe(true));
    expect(needs(store.getSnapshot())).toHaveLength(0); // ein Ladefehler ist kein Fehler eines Runs
    store.open(A, "s9");
    await vi.waitFor(() => expect(conv(store, A, "s9")?.stale).toBeUndefined());
    expect(conv(store, A, "s9")?.state.items).toHaveLength(1);
  });

  it("sends the next queued message after a clean end, with the chosen model", async () => {
    const { store, api } = setup();
    await store.send(A, undefined, "erste", [], { model: "mock-small" });
    store.enqueue("hikari/hermes/raiden#s1", "zweite", []);
    last().emit({ type: "run.completed" });
    await vi.waitFor(() => expect(api.startRun).toHaveBeenCalledTimes(2));
    expect(api.startRun.mock.calls[1][1]).toMatchObject({ text: "zweite", session_id: "s1", model: "mock-small" });
    expect(conv(store, A, "s1")?.state.queued).toHaveLength(0);
  });

  it("does not send queued messages after a failure, and lists the failure in the inbox", async () => {
    const { store, api } = setup();
    await store.send(A, undefined, "erste", []);
    store.enqueue("hikari/hermes/raiden#s1", "zweite", []);
    last().emit({ type: "run.failed", error: "Key abgelaufen" });
    expect(api.startRun).toHaveBeenCalledTimes(1);
    const [n] = needs(store.getSnapshot());
    expect(n).toMatchObject({ kind: "failed", error: "Key abgelaufen" });
    store.dismiss(n.id);
    expect(needs(store.getSnapshot())).toHaveLength(0);
  });

  it("lists a run that could not be started and drops it when the person starts a fresh chat", async () => {
    const { store } = setup({ startRun: vi.fn(async () => { throw new Error("Hermes nicht erreichbar"); }) });
    await store.send(B, undefined, "hallo", []);
    expect(needs(store.getSnapshot())[0]).toMatchObject({ kind: "failed", error: "Hermes nicht erreichbar", topic: "hallo" });
    store.open(B, undefined);
    expect(conv(store, B)).toBeUndefined();
  });

  it("marks a broken stream as lost unless the run has already ended", async () => {
    const { store, api } = setup();
    await store.send(A, undefined, "x", []);
    last().onerror?.();
    await vi.waitFor(() => expect(conv(store, A, "s1")?.state.runStatus).toBe("lost"));
    expect(needs(store.getSnapshot())[0].kind).toBe("lost");

    api.runStatus.mockResolvedValue({ status: "completed" });
    await store.send(B, undefined, "y", []);
    last().onerror?.();
    await vi.waitFor(() => expect(api.messages).toHaveBeenCalled());
    expect(conv(store, B, "s2")?.state.runStatus).toBe("idle");
  });

  it("tells listeners which agent finished a run", async () => {
    const { store } = setup();
    const ended = vi.fn();
    store.onRunEnd(ended);
    await store.send(A, undefined, "x", []);
    last().emit({ type: "run.stopped" });
    expect(ended).toHaveBeenCalledWith(A);
  });

  it("forgets the oldest finished conversations but never a running one", async () => {
    const { store } = setup();
    await store.send(A, undefined, "läuft", []);
    for (let i = 0; i < 45; i++) store.open(B, `h${i}`);
    await vi.waitFor(() => expect(conv(store, B, "h44")).toBeDefined());
    expect(store.getSnapshot().convs.size).toBe(40);
    expect(conv(store, B, "h0")).toBeUndefined();
    expect(conv(store, A, "s1")?.state.runStatus).toBe("running");
  });
});
