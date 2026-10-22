import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { FakeEventSource, emit, installBackend } from "../test-backend";

let posted: ReturnType<typeof installBackend>["posted"];

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

beforeEach(() => { resetRedirect(); ({ posted } = installBackend(["raiden"])); });
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
    expect(posted("/runs")[1].body).toMatchObject({ text: "danach die Doku", session_id: "s1" });
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
