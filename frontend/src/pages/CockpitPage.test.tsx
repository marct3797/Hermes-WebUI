import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { FakeEventSource, emit, installBackend, roomOf } from "../test-backend";

let posted: ReturnType<typeof installBackend>["posted"];

beforeEach(() => { resetRedirect(); ({ posted } = installBackend(["raiden", "sora"])); document.title = "Hermes"; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const card = (name: string) => within(screen.getByRole("main")).getByRole("link", { name: new RegExp(`^${name}, `) });

/** Im Chat eines Agents einen Run starten und innerhalb der App zum Cockpit zurück. */
async function runIn(agent: string, text: string) {
  fireEvent.click((await screen.findAllByRole("link", { name: new RegExp(`^${agent}`) }))[0]);
  const box = await screen.findByPlaceholderText(`Nachricht an ${agent}…`);
  await waitFor(() => expect(screen.getByRole("button", { name: "Senden" })).toBeDisabled());
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Senden" }));
  await waitFor(() => expect(FakeEventSource.all.some((s) => s.url.includes(`/${agent}/runs/`))).toBe(true));
}
const toCockpit = () => fireEvent.click(screen.getAllByRole("link", { name: "Cockpit" })[0]);

describe("Cockpit", () => {
  it("lists what agents wait for in a room, and approves it from the cockpit", async () => {
    const { rooms, calls } = installBackend(["raiden", "sora"]);
    rooms.push(roomOf("abcabcabcabc", "Planungsrunde", ["raiden", "sora"], { asks: [{ kind: "approval", member: "hikari/hermes/sora", run_id: "run_9", command: "rm -r build", reason: "", choices: ["once", "deny"], at: 1 }] }));
    history.pushState(null, "", "/");
    render(<App />);
    const panel = await screen.findByRole("region", { name: "Braucht dich" });
    expect(await within(panel).findByText("sora fragt nach Freigabe")).toBeInTheDocument();
    expect(within(panel).getByText(/rm -r build · Raum Planungsrunde/)).toBeInTheDocument();
    const kpis = screen.getByRole("group", { name: "Kennzahlen" });
    expect(within(kpis).getByText("1 Freigabe")).toBeInTheDocument();
    expect(document.title).toBe("(1) Hermes");
    expect(within(panel).getByRole("link", { name: "Raum öffnen" })).toHaveAttribute("href", "/rooms/abcabcabcabc");
    fireEvent.click(within(panel).getByRole("button", { name: "Einmal erlauben" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/bff/h/hikari/hermes/sora/runs/run_9/approval")?.body).toEqual({ decision: "once" }));
  });

  it("shows a room that called for the person in the panel and counts it", async () => {
    const { rooms } = installBackend(["raiden", "sora"]);
    rooms.push(roomOf("abcabcabcabc", "Planungsrunde", ["raiden", "sora"], { needs_user: true }));
    history.pushState(null, "", "/");
    render(<App />);
    const panel = await screen.findByRole("region", { name: "Braucht dich" });
    expect(await within(panel).findByText("Raum Planungsrunde ruft dich")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Kennzahlen" })).getByText("1 Raum ruft")).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "Öffnen" })).toHaveAttribute("href", "/rooms/abcabcabcabc");
  });

  it("shows every agent with its state and last chat, and marks the unreachable host", async () => {
    history.pushState(null, "", "/");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Alle Agents" })).toBeInTheDocument();
    await waitFor(() => expect(within(card("raiden")).getByText("Alter Chat von raiden")).toBeInTheDocument());
    expect(within(card("raiden")).getByText("BEREIT")).toBeInTheDocument();
    expect(within(card("raiden")).getByText(/letzter Chat vor 2 Std/)).toBeInTheDocument();
    const laptop = within(screen.getByRole("main")).getByRole("region", { name: "Laptop" });
    expect(within(laptop).getByText("OFFLINE")).toBeInTheDocument();
    const kpis = screen.getByRole("group", { name: "Kennzahlen" });
    expect(within(kpis).getByText("Laptop nicht erreichbar")).toBeInTheDocument();
    expect(within(kpis).getByText("nichts offen")).toBeInTheDocument();
    expect(screen.getByText(/Nichts offen\. Freigaben/)).toBeInTheDocument();
  });

  it("filters by host, running and needs-you", async () => {
    history.pushState(null, "", "/");
    render(<App />);
    await screen.findByRole("heading", { name: "Alle Agents" });
    fireEvent.click(screen.getByRole("button", { name: /^Laptop/ }));
    const main = within(screen.getByRole("main"));
    expect(main.queryByRole("link", { name: /^raiden/ })).toBeNull();
    expect(main.getByRole("link", { name: /^default/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Läuft/ }));
    expect(screen.getByText("Kein Agent passt zu diesem Filter.")).toBeInTheDocument();
  });

  it("keeps a run visible after leaving its chat and lets the person approve from the cockpit", async () => {
    history.pushState(null, "", "/");
    render(<App />);
    await runIn("raiden", "räum den Build auf");
    emit({ type: "approval.requested", command: "rm -r build", reason: "räumt auf", choices: ["once", "deny"], timeout_s: 300 }, "raiden");
    await runIn("sora", "lies die Doku");
    toCockpit();

    await screen.findByRole("heading", { name: "Alle Agents" });
    expect(within(card("raiden")).getByText("WARTET")).toBeInTheDocument();
    expect(within(card("raiden")).getByText(/wartet auf Freigabe/)).toBeInTheDocument();
    expect(within(card("sora")).getByText("LÄUFT")).toBeInTheDocument();
    expect(document.title).toBe("(1) Hermes");

    const needs = screen.getByRole("region", { name: "Braucht dich" });
    expect(within(needs).getByText("raiden fragt nach Freigabe")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Läuft gerade" })).toHaveTextContent("2 Runs");
    // Zähler in der Seitenleiste hängen am selben Zustand
    expect(screen.getByRole("link", { name: /^Inbox/ })).toHaveTextContent("1");

    fireEvent.click(within(needs).getByRole("button", { name: /Einmal erlauben/ }));
    await waitFor(() => expect(posted("/approval")).toHaveLength(1));
    expect(posted("/approval")[0].url).toBe("/bff/h/hikari/hermes/raiden/runs/run_1/approval");
    expect(posted("/approval")[0].body).toEqual({ decision: "once" });
    expect(await within(needs).findByText("Entscheidung gespeichert")).toBeInTheDocument();
    expect(document.title).toBe("Hermes");
    expect(within(card("raiden")).getByText("LÄUFT")).toBeInTheDocument();
  });

  it("does not stop a run when the person leaves its chat", async () => {
    history.pushState(null, "", "/");
    render(<App />);
    await runIn("raiden", "lang");
    toCockpit();
    await screen.findByRole("heading", { name: "Alle Agents" });
    expect(FakeEventSource.all[0].closed).toBe(false);
    expect(posted("/stop")).toHaveLength(0);
    // zurück in den Chat: derselbe laufende Run, kein neuer Abruf des Verlaufs
    fireEvent.click(card("raiden"));
    expect(await screen.findByRole("article", { name: "Du" })).toHaveTextContent("lang");
  });
});
