import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { FakeEventSource, emit, installBackend, roomOf } from "../test-backend";

let posted: ReturnType<typeof installBackend>["posted"];

beforeEach(() => { resetRedirect(); ({ posted } = installBackend(["gamma", "eta"])); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function runIn(agent: string, text: string) {
  fireEvent.click((await screen.findAllByRole("link", { name: new RegExp(`^${agent}`) }))[0]);
  const box = await screen.findByPlaceholderText(`Nachricht an ${agent}…`);
  await waitFor(() => expect(screen.getByRole("button", { name: "Senden" })).toBeDisabled());
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Senden" }));
  await waitFor(() => expect(FakeEventSource.all.some((s) => s.url.includes(`/${agent}/runs/`))).toBe(true));
}
const toInbox = () => fireEvent.click(screen.getAllByRole("link", { name: /^Inbox/ })[0]);

async function twoApprovals() {
  history.pushState(null, "", "/");
  render(<App />);
  await runIn("gamma", "räum auf");
  emit({ type: "approval.requested", command: "rm -r build", reason: "räumt auf", choices: ["once", "session", "always", "deny"], timeout_s: 300 }, "gamma");
  await runIn("eta", "push es");
  emit({ type: "approval.requested", command: "git push --force", reason: "", choices: ["once", "deny"], timeout_s: 120, smart_denied: true }, "eta");
  toInbox();
  await screen.findByRole("heading", { name: "Braucht dich", level: 1 });
}

describe("Inbox", () => {
  it("lists rooms that call for the person, and counts them in the badges and the tab title", async () => {
    const { rooms } = installBackend(["gamma"]);
    rooms.push(roomOf("abcabcabcabc", "Planungsrunde", ["gamma", "eta"], { needs_user: true }), roomOf("defdefdefdef", "Ruhiger Raum", ["gamma"]));
    history.pushState(null, "", "/inbox");
    render(<App />);
    const group = await screen.findByRole("group", { name: "Räume" });
    expect(within(group).getByRole("link", { name: /Planungsrunde/ })).toHaveAttribute("href", "/rooms/abcabcabcabc");
    expect(within(group).queryByText("Ruhiger Raum")).not.toBeInTheDocument();
    expect(screen.getByText("1 offen · 0 laufen ab")).toBeInTheDocument();
    const nav = within(screen.getByRole("complementary", { name: "Navigation" }));
    expect(nav.getByRole("link", { name: /^Räume/ })).toHaveTextContent("1");
    expect(nav.getByRole("link", { name: /^Inbox/ })).toHaveTextContent("1");
    await waitFor(() => expect(document.title).toBe("(1) Hermes")); // der Titel wird in einem Effekt gesetzt, kurz nach dem Zähler
    expect(screen.queryByText("Nichts offen.")).not.toBeInTheDocument();
  });

  it("shows what agents wait for in a room, with a link to the room, and answers it in place", async () => {
    const { rooms, calls } = installBackend(["gamma", "eta"]);
    rooms.push(roomOf("abcabcabcabc", "Planungsrunde", ["gamma", "eta"], { asks: [
      { kind: "approval", member: "server/hermes/eta", run_id: "run_9", command: "rm -r build", reason: "räumt auf", choices: ["once", "deny"], at: 1 },
      { kind: "clarify", member: "server/hermes/gamma", run_id: "run_4", clarify_id: "c1", question: "Welche Datei?", choices: [], at: 2 },
    ] }));
    history.pushState(null, "", "/inbox");
    render(<App />);
    const group = await screen.findByRole("group", { name: "Räume" });
    const approval = await within(group).findByRole("group", { name: "eta braucht dich" });
    expect(within(approval).getByText("rm -r build")).toBeInTheDocument();
    expect(within(approval).getByRole("link", { name: "Planungsrunde" })).toHaveAttribute("href", "/rooms/abcabcabcabc");
    expect(within(group).getByText("Welche Datei?")).toBeInTheDocument();
    expect(screen.getByText("2 offen · 0 laufen ab")).toBeInTheDocument();
    fireEvent.click(within(approval).getByRole("button", { name: "Ablehnen" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/bff/h/server/hermes/eta/runs/run_9/approval")?.body).toEqual({ decision: "deny" }));
    fireEvent.change(within(group).getByLabelText("Antwort"), { target: { value: "die erste" } });
    fireEvent.click(within(group).getByRole("button", { name: "Senden" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/bff/h/server/hermes/gamma/runs/run_4/clarify")?.body).toEqual({ answer: "die erste", clarify_id: "c1" }));
  });

  it("says so when nothing is open", async () => {
    history.pushState(null, "", "/inbox");
    render(<App />);
    expect(await screen.findByText("Nichts offen")).toBeInTheDocument();
    expect(screen.getByText("Noch nichts entschieden.")).toBeInTheDocument();
  });

  it("lists approvals by deadline and shows the command and the allowed ways", async () => {
    await twoApprovals();
    const list = screen.getByRole("group", { name: "Läuft ab" });
    const rows = within(list).getAllByRole("button");
    // die kürzere Frist (eta, 2 Minuten) steht oben
    expect(rows[0]).toHaveTextContent("Smart-Deny: Freigabe nötig");
    expect(rows[1]).toHaveTextContent("Freigabe nötig");
    const detail = screen.getByRole("group", { name: "Deine Entscheidung" });
    const details = within(screen.getByRole("region", { name: "Details" }));
    expect(details.getByText("git push --force")).toBeInTheDocument();
    expect(details.getByText("Hermes rät ab (Smart-Deny)")).toBeInTheDocument();
    expect(within(detail).queryByRole("button", { name: /Immer erlauben/ })).toBeNull();
    expect(within(detail).queryByRole("button", { name: /Für Session/ })).toBeNull();
    expect(within(detail).getByRole("button", { name: /Einmal erlauben/ })).toBeInTheDocument();
    expect(within(detail).getByRole("button", { name: /Ablehnen/ })).toBeInTheDocument();
  });

  it("switches with J and K and decides with the keyboard", async () => {
    await twoApprovals();
    fireEvent.keyDown(document.body, { key: "j" });
    expect(within(screen.getByRole("region", { name: "Details" })).getByText("rm -r build")).toBeInTheDocument();
    const detail = screen.getByRole("group", { name: "Deine Entscheidung" });
    expect(within(detail).getByRole("button", { name: /Immer erlauben/ })).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "s" });
    await waitFor(() => expect(posted("/approval")).toHaveLength(1));
    expect(posted("/approval")[0].url).toContain("/gamma/");
    expect(posted("/approval")[0].body).toEqual({ decision: "session" });
    // erledigt: wandert in die Liste „Erledigt heute“, die andere Freigabe rückt nach
    expect(await screen.findByText(/rm -r build · für die Session erlaubt/)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Details" })).getByText("git push --force")).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(posted("/approval")).toHaveLength(2));
    expect(posted("/approval")[1].body).toEqual({ decision: "deny" });
    expect(await screen.findByText("Nichts offen")).toBeInTheDocument();
  });

  it("filters by tab", async () => {
    await twoApprovals();
    fireEvent.click(screen.getByRole("tab", { name: /Rückfragen/ }));
    expect(screen.getByText("Nichts in dieser Ansicht.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /Freigaben/ }));
    expect(screen.getAllByRole("button", { name: /Freigabe nötig/ })).toHaveLength(2);
  });

  it("answers a question with a suggested choice or a typed answer", async () => {
    history.pushState(null, "", "/");
    render(<App />);
    await runIn("eta", "Wochenbericht");
    emit({ type: "clarify.requested", clarify_id: "c1", question: "Hindsight einbeziehen?", choices: ["Ja", "Nein"] }, "eta");
    toInbox();
    expect(await screen.findByRole("heading", { name: "eta braucht eine Entscheidung" })).toBeInTheDocument();
    const send = screen.getByRole("button", { name: /Antwort senden/ });
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "Ja" }));
    fireEvent.click(send);
    await waitFor(() => expect(posted("/clarify")).toHaveLength(1));
    expect(posted("/clarify")[0].body).toEqual({ answer: "Ja", clarify_id: "c1" });
    expect(await screen.findByText(/Rückfrage beantwortet/)).toBeInTheDocument();
  });

  it("lists a failed run and lets the person dismiss it", async () => {
    history.pushState(null, "", "/");
    render(<App />);
    await runIn("gamma", "mach was");
    emit({ type: "run.failed", error: "Key abgelaufen" }, "gamma");
    toInbox();
    expect(await screen.findByRole("heading", { name: "Der Run ist fehlgeschlagen" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Key abgelaufen");
    expect(screen.getByRole("link", { name: /Chat öffnen/ })).toHaveAttribute("href", "/h/server/hermes/gamma/chat/s1");
    fireEvent.click(screen.getByRole("button", { name: "Als gelesen markieren" }));
    expect(await screen.findByText("Nichts offen")).toBeInTheDocument();
  });
});
