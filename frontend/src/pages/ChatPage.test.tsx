import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import type { HostInfo, StreamEvent } from "../types";

const HOSTS: HostInfo[] = [
  { id: "hikari", label: "Hikari", kind: "local", address: null, status: "online", detail: null, runtimes: [
    { id: "hermes", label: "Hermes", status: "online", version: "0.21.6", detail: null, multiplex: true, agents: [{ id: "raiden", label: "raiden" }] }] },
];

class FakeEventSource {
  static all: FakeEventSource[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeEventSource.all.push(this); }
  close() { this.closed = true; }
}
const emit = (ev: StreamEvent, i = FakeEventSource.all.length - 1) =>
  act(() => { FakeEventSource.all[i].onmessage?.(new MessageEvent("message", { data: JSON.stringify(ev) })); });

type Call = { method: string; url: string; body?: Record<string, unknown> };
let calls: Call[];
let runCount: number;

function backend() {
  calls = [];
  runCount = 0;
  const A = "/bff/h/hikari/hermes/raiden";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/bff/me") return json({ user: { id: "42", name: "marc" }, auth_mode: "none", fresh: true });
    if (url === "/bff/hosts") return json({ hosts: HOSTS, config_error: null });
    if (url === "/bff/ui") return json({ ui: { backgroundShader: { enabled: false, strength: 1, speed: 1 } }, sigils: {}, warnings: [], error: null });
    if (url === `${A}/status`) return json({ state: "online", online: true, version: "0.21.6", features: ["runs", "steer"], error: null });
    if (url === `${A}/models`) return json({ models: [{ id: "mock-large" }] });
    if (url === `${A}/sessions`) return json({ data: [] });
    if (method === "POST" && url === `${A}/runs`) return json({ run_id: `run_${++runCount}`, session_id: "s9" });
    if (method === "POST" && /\/runs\/run_\d+\/(approval|steer|stop)$/.test(url)) return json({});
    return json({ detail: "nicht da" }, 404);
  }));
}

const posted = (suffix: string) => calls.filter((c) => c.method === "POST" && c.url.endsWith(suffix));

async function startRun(text = "Prüfe die Tests") {
  history.pushState(null, "", "/h/hikari/hermes/raiden/chat");
  render(<App />);
  const box = await screen.findByPlaceholderText("Nachricht an raiden…");
  await waitFor(() => expect(screen.getByRole("button", { name: "Senden" })).toBeDisabled());
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Senden" }));
  await waitFor(() => expect(FakeEventSource.all).toHaveLength(1));
  return text;
}

beforeEach(() => { resetRedirect(); FakeEventSource.all = []; backend(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Chat", () => {
  it("sends a run, streams the answer and shows the tool in the inspector", async () => {
    await startRun();
    expect(posted("/runs")[0].body).toMatchObject({ text: "Prüfe die Tests" });
    expect(FakeEventSource.all[0].url).toBe("/bff/h/hikari/hermes/raiden/runs/run_1/events");
    expect(screen.getByRole("article", { name: "Du" })).toHaveTextContent("Prüfe die Tests");

    emit({ type: "reasoning.delta", text: "Erst lesen\n\nDann laufen lassen" });
    emit({ type: "message.delta", text: "Ich starte " });
    emit({ type: "tool.started", id: "t1", name: "terminal", preview: "pytest -q" });
    emit({ type: "tool.completed", id: "t1", name: "terminal", ok: true, duration_ms: 3200, output: "12 passed" });
    emit({ type: "message.delta", text: "**fertig**." });

    expect(await screen.findByRole("button", { name: /Denkprozess/ })).toBeInTheDocument();
    const insp = screen.getByRole("complementary", { name: "Inspector" });
    expect(within(insp).getByText("12 passed")).toBeInTheDocument();
    expect(screen.getByText("fertig", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByRole("log")).toHaveTextContent("Ich starte");

    emit({ type: "run.completed", usage: { total_tokens: 1234 } });
    expect(await screen.findByText("1.234")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Senden" })).toBeDisabled();
  });

  it("answers an approval with the keyboard and collapses the card", async () => {
    await startRun();
    emit({ type: "approval.requested", command: "rm -r build", reason: "räumt auf", choices: ["once", "session", "always", "deny"], timeout_s: 300 });
    const card = await screen.findByRole("group", { name: "Freigabe nötig" });
    expect(within(card).getByRole("button", { name: "Immer" })).toBeInTheDocument();
    expect(screen.getByText("WARTET AUF FREIGABE")).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "s" });
    await waitFor(() => expect(posted("/approval")).toHaveLength(1));
    expect(posted("/approval")[0].body).toEqual({ decision: "session" });
    expect(await screen.findByRole("group", { name: "Freigabe entschieden" })).toHaveTextContent("Für diese Session erlaubt");
  });

  it("does not offer or accept a hotkey for a choice the agent did not allow", async () => {
    await startRun();
    emit({ type: "approval.requested", command: "rm -r /", reason: "", choices: ["once", "deny"], timeout_s: 300, smart_denied: true });
    await screen.findByRole("group", { name: "Freigabe nötig" });
    fireEvent.keyDown(document.body, { key: "A", shiftKey: true });
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(posted("/approval")).toHaveLength(1));
    expect(posted("/approval")[0].body).toEqual({ decision: "deny" });
  });

  it("ignores hotkeys while typing in the message box", async () => {
    await startRun();
    emit({ type: "approval.requested", command: "ls", reason: "", choices: ["once", "deny"], timeout_s: 300 });
    await screen.findByRole("group", { name: "Freigabe nötig" });
    const box = screen.getByRole("textbox", { name: "Nachricht" });
    box.focus();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(posted("/approval")).toHaveLength(0);
  });

  it("steers a running run and queues a message for after it", async () => {
    await startRun();
    const box = screen.getByRole("textbox", { name: "Nachricht" });

    fireEvent.change(box, { target: { value: "lieber kurz" } });
    fireEvent.click(screen.getByRole("button", { name: "Senden" }));
    await waitFor(() => expect(posted("/steer")).toHaveLength(1));
    expect(posted("/steer")[0].body).toEqual({ text: "lieber kurz" });
    expect(screen.getByText("STEER")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    fireEvent.change(box, { target: { value: "danach die Doku" } });
    fireEvent.click(screen.getByRole("button", { name: "Senden" }));
    const queue = await screen.findByRole("list", { name: "Vorgemerkte Nachrichten" });
    expect(queue).toHaveTextContent("danach die Doku");
    expect(posted("/runs")).toHaveLength(1);

    emit({ type: "run.completed" });
    await waitFor(() => expect(posted("/runs")).toHaveLength(2));
    expect(posted("/runs")[1].body).toMatchObject({ text: "danach die Doku", session_id: "s9" });
    expect(screen.queryByRole("list", { name: "Vorgemerkte Nachrichten" })).toBeNull();
  });

  it("does not send queued messages after a failed run", async () => {
    await startRun();
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Nachricht" }), { target: { value: "später" } });
    fireEvent.click(screen.getByRole("button", { name: "Senden" }));
    await screen.findByRole("list", { name: "Vorgemerkte Nachrichten" });
    emit({ type: "run.failed", error: "Key abgelaufen" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Key abgelaufen");
    expect(posted("/runs")).toHaveLength(1);
    // Die Person entscheidet: manuell senden.
    fireEvent.click(screen.getByRole("button", { name: "Jetzt senden" }));
    await waitFor(() => expect(posted("/runs")).toHaveLength(2));
  });
});
