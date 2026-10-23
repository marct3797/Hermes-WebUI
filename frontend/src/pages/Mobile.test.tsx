import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { FakeEventSource, emit, installBackend } from "../test-backend";

const sidebar = () => screen.findByRole("complementary", { name: "Navigation" });
const bar = async () => within(await screen.findByRole("navigation", { name: "Hauptnavigation" }));

beforeEach(() => { resetRedirect(); installBackend(["raiden", "sora"]); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function openApproval() {
  history.pushState(null, "", "/h/hikari/hermes/raiden/chat");
  render(<App />);
  const box = await screen.findByPlaceholderText("Nachricht an raiden…");
  await waitFor(() => expect(screen.getByRole("button", { name: "Senden" })).toBeDisabled());
  fireEvent.change(box, { target: { value: "räum auf" } });
  fireEvent.click(screen.getByRole("button", { name: "Senden" }));
  await waitFor(() => expect(FakeEventSource.all.length).toBeGreaterThan(0));
  emit({ type: "approval.requested", command: "rm -r build", reason: "", choices: ["once", "session", "always", "deny"], timeout_s: 300 });
}

describe("Handy: Tab-Leiste", () => {
  it("has Cockpit, Inbox, Chats and Mehr and marks the current page", async () => {
    history.pushState(null, "", "/");
    render(<App />);
    const tabs = await bar();
    expect(tabs.getByRole("link", { name: /Cockpit/ })).toHaveAttribute("aria-current", "page");
    expect(tabs.getByRole("link", { name: /Inbox/ })).not.toHaveAttribute("aria-current");
    expect(tabs.getByRole("button", { name: "Chats" })).toBeInTheDocument();
    expect(tabs.getByRole("button", { name: "Mehr" })).toHaveAttribute("aria-expanded", "false");
    expect(tabs.queryByLabelText(/offen/)).toBeNull(); // nichts offen: kein Zähler
  });

  it("shows how many things need the person, taken from the same state as the inbox", async () => {
    await openApproval();
    fireEvent.click(await screen.findByRole("link", { name: "Zurück zum Cockpit" }));
    const tabs = await bar();
    expect(await tabs.findByLabelText("1 offen")).toBeInTheDocument();
  });

  it("opens the drawer with agents and sessions through Chats", async () => {
    history.pushState(null, "", "/");
    render(<App />);
    expect(await sidebar()).not.toHaveClass("open");
    fireEvent.click((await bar()).getByRole("button", { name: "Chats" }));
    expect(await sidebar()).toHaveClass("open");
    expect(within(await sidebar()).getByRole("link", { name: /^raiden/ })).toBeInTheDocument();
  });

  it("opens a sheet with Hosts and Darstellung through Mehr, and closes it with Escape or when going somewhere", async () => {
    history.pushState(null, "", "/");
    render(<App />);
    const more = (await bar()).getByRole("button", { name: "Mehr" });
    fireEvent.click(more);
    const sheet = within(screen.getByRole("dialog", { name: "Mehr" }));
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(sheet.getByRole("link", { name: "Hosts" })).toHaveAttribute("href", "/hosts");
    expect(sheet.getByRole("link", { name: "Darstellung" })).toHaveAttribute("href", "/settings");
    expect(sheet.getByText("Kanban")).toHaveAttribute("aria-disabled", "true");
    expect(sheet.queryByRole("button", { name: "Abmelden" })).toBeNull(); // ohne Anmeldung gibt es nichts abzumelden
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Mehr" })).toBeNull();
    fireEvent.click(more);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Mehr" })).getByRole("link", { name: "Hosts" }));
    await screen.findByRole("heading", { name: "Hosts", level: 1 });
    expect(screen.queryByRole("dialog", { name: "Mehr" })).toBeNull();
  });

  it("is not part of the chat view, which has its own back button and drawer", async () => {
    history.pushState(null, "", "/h/hikari/hermes/raiden/chat");
    render(<App />);
    await screen.findByPlaceholderText("Nachricht an raiden…");
    expect(screen.queryByRole("navigation", { name: "Hauptnavigation" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Agents und Sessions öffnen" }));
    expect(await sidebar()).toHaveClass("open");
    fireEvent.click(screen.getByRole("link", { name: "Zurück zum Cockpit" }));
    await screen.findByRole("heading", { name: "Alle Agents", level: 1 });
  });
});

describe("Handy: Freigabe und Inbox", () => {
  it("lays the ways to decide out as one group the phone can stack", async () => {
    await openApproval();
    const group = await screen.findByRole("group", { name: "Freigabe nötig" });
    const ways = group.querySelector(".btns.ways")!;
    expect([...ways.querySelectorAll("button")].map((b) => b.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      expect.stringContaining("Einmal erlauben"), expect.stringContaining("Für Session"), expect.stringContaining("Immer"), expect.stringContaining("Ablehnen"),
    ]);
  });

  it("scrolls the chosen message into view when list and details are stacked", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width: 1000px"), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    await openApproval();
    fireEvent.click(await screen.findByRole("link", { name: "Zurück zum Cockpit" }));
    fireEvent.click(within(await screen.findByRole("navigation", { name: "Hauptnavigation" })).getByRole("link", { name: /Inbox/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Freigabe nötig/ }));
    expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });
});
