import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { emitRoom, installBackend, roomOf } from "../test-backend";
import type { Room, RoomMessage } from "../types";

const RID = "111111111111";
const A = "server/hermes/gamma", B = "server/hermes/eta";
const m = (seq: number, author: string, text: string, mentions: string[] = []): RoomMessage => ({ seq, author, kind: "message", text, mentions, at: 1_792_000_000 + seq });

let env: ReturnType<typeof installBackend>;

async function open(extra: Partial<Room> = {}) {
  env = installBackend(["gamma", "eta"]);
  env.rooms.push(roomOf(RID, "Planung", ["gamma", "eta"], { messages: [m(1, "user", "Hallo zusammen"), m(2, A, "Moin, **Alex**.")], ...extra }));
  history.pushState(null, "", `/rooms/${RID}`);
  render(<App />);
  await screen.findByRole("heading", { name: "Planung", level: 1 });
}

beforeEach(() => resetRedirect());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Raum", () => {
  it("shows the history with who said what, agent text as markdown", async () => {
    await open();
    const log = screen.getByRole("log", { name: "Verlauf" });
    expect(within(log).getByText("Hallo zusammen")).toBeInTheDocument();
    expect(within(log).getByText("Alex").tagName).toBe("STRONG");
    expect(within(log).getAllByRole("article").map((a) => a.getAttribute("aria-label")?.split(" um ")[0])).toEqual(["Du", "gamma"]);
  });

  it("sends on Enter, keeps Shift+Enter for a new line, and clears the field", async () => {
    await open();
    const box = screen.getByLabelText("Nachricht an den Raum");
    fireEvent.change(box, { target: { value: "@eta was meinst du?" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(env.calls.some((c) => c.url.endsWith("/messages"))).toBe(false);
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(box).toHaveValue(""));
    expect(env.calls.find((c) => c.url === `/bff/rooms/${RID}/messages`)?.body).toEqual({ text: "@eta was meinst du?" });
  });

  it("inserts a mention where the cursor is", async () => {
    await open();
    const box = screen.getByLabelText("Nachricht an den Raum") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Hallo" } });
    fireEvent.click(screen.getByRole("button", { name: "@eta einfügen" }));
    expect(box.value).toBe("Hallo @eta ");
    fireEvent.click(screen.getByRole("button", { name: "@all einfügen" }));
    expect(box.value).toContain("@all");
  });

  it("shows who is typing, then swaps the live text for the finished message", async () => {
    await open();
    emitRoom({ type: "turn.started", turn: "t1" });
    emitRoom({ type: "member.started", member: B, round: 1 });
    emitRoom({ type: "member.event", member: B, run_id: "run_9", event: { type: "message.delta", text: "Ich über" } });
    const live = await screen.findByRole("article", { name: "eta schreibt" });
    expect(within(live).getByText(/Ich über/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stopp" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Senden" })).not.toBeInTheDocument();
    emitRoom({ type: "message", message: m(3, B, "Ich überlege noch.") });
    await waitFor(() => expect(screen.queryByRole("article", { name: "eta schreibt" })).not.toBeInTheDocument());
    expect(screen.getByText("Ich überlege noch.")).toBeInTheDocument();
  });

  it("stops the room on request", async () => {
    await open({ running: true, speaker: B });
    fireEvent.click(await screen.findByRole("button", { name: "Stopp" }));
    await waitFor(() => expect(env.calls.some((c) => c.method === "POST" && c.url === `/bff/rooms/${RID}/stop`)).toBe(true));
  });

  const askOf = (run_id = "run_9") => ({ kind: "approval" as const, member: B, run_id, command: "rm -r build", reason: "räumt auf", choices: ["once", "deny"] as Array<"once" | "deny">, timeout_s: 300, at: 1 });

  it("answers a member's approval through that member's own run", async () => {
    await open();
    emitRoom({ type: "turn.started", turn: "t1" });
    emitRoom({ type: "asks", asks: [askOf()] });
    const card = await screen.findByRole("group", { name: "eta braucht dich" });
    expect(within(card).getByText("rm -r build")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Einmal erlauben" }));
    await waitFor(() => expect(env.calls.find((c) => c.url === "/bff/h/server/hermes/eta/runs/run_9/approval")?.body).toEqual({ decision: "once" }));
    emitRoom({ type: "asks", asks: [] });
    await waitFor(() => expect(screen.queryByRole("group", { name: "eta braucht dich" })).not.toBeInTheDocument());
  });

  it("shows a waiting approval again after the page was opened later or reconnected", async () => {
    await open({ running: true, speaker: B });
    emitRoom({ type: "state", running: true, speaker: B, asks: [askOf("run_7")] });
    const card = await screen.findByRole("group", { name: "eta braucht dich" });
    fireEvent.click(within(card).getByRole("button", { name: "Ablehnen" }));
    await waitFor(() => expect(env.calls.find((c) => c.url === "/bff/h/server/hermes/eta/runs/run_7/approval")?.body).toEqual({ decision: "deny" }));
  });

  it("says who needs the person and why", async () => {
    await open({ needs_user: true, messages: [m(1, "user", "Räum auf"), m(2, B, "@user darf ich Dateien löschen?", ["user"])] });
    const banner = await screen.findByRole("status");
    expect(within(banner).getByText("eta")).toBeInTheDocument();
    expect(banner).toHaveTextContent("darf ich Dateien löschen?");
  });

  it("tells why a turn stopped on its own", async () => {
    await open();
    emitRoom({ type: "turn.started", turn: "t1" });
    emitRoom({ type: "turn.finished", turn: "t1", reason: "max_rounds" });
    expect(await screen.findByText(/Nach 3 Runden angehalten/)).toBeInTheDocument();
  });

  it("archives the room and goes back to the list", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Archivieren" }));
    await waitFor(() => expect(location.pathname).toBe("/rooms"));
    expect(env.calls.find((c) => c.method === "PATCH")?.body).toEqual({ archived: true });
  });

  it("does not offer to send into an archived room", async () => {
    await open({ archived: true });
    expect(screen.getByLabelText("Nachricht an den Raum")).toBeDisabled();
  });

  it("reports a room that does not exist", async () => {
    env = installBackend(["gamma", "eta"]);
    history.pushState(null, "", "/rooms/ffffffffffff");
    render(<App />);
    expect(await screen.findByText(/Raum nicht ladbar/)).toBeInTheDocument();
  });
});
