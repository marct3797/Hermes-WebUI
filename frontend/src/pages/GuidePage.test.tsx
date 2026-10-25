import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { GUIDE } from "../guide";
import { installBackend } from "../test-backend";

let calls: ReturnType<typeof installBackend>["calls"];

async function open(agents = ["gamma"]) {
  ({ calls } = installBackend(agents));
  history.pushState(null, "", "/guide");
  render(<App />);
  await screen.findByRole("heading", { name: "Anleitungen", level: 1 });
}
const card = (id: string) => within(screen.getByRole("region", { name: GUIDE.find((e) => e.id === id)!.title }));

beforeEach(() => resetRedirect());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("GuidePage", () => {
  it("renders every entry with title, command and warning", async () => {
    await open();
    expect(GUIDE.length).toBeGreaterThanOrEqual(8);
    for (const e of GUIDE) {
      const c = card(e.id);
      expect(c.getByRole("heading", { name: e.title })).toBeInTheDocument();
      expect(c.getByText(e.command)).toBeInTheDocument();
      expect(c.getByText(e.caution)).toBeInTheDocument();
    }
  });

  it("copies the command of the chosen entry to the clipboard", async () => {
    await open();
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: write } });
    fireEvent.click(card("gateway").getByRole("button", { name: "Befehl kopieren" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith("hermes gateway migrate --dry-run"));
    expect(await card("gateway").findByRole("button", { name: "Kopiert" })).toBeInTheDocument();
  });

  it("check calls its own read route and shows the result", async () => {
    await open();
    fireEvent.click(card("whatsapp").getByRole("button", { name: "Ergebnis prüfen" }));
    await card("whatsapp").findByText("Telegram: disabled");
    expect(calls.some((c) => c.method === "GET" && c.url.endsWith("/messaging"))).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/gateway"))).toBe(false);
  });

  it("shows a dashboard error instead of swallowing it", async () => {
    await open();
    const f = vi.mocked(globalThis.fetch);
    const orig = f.getMockImplementation()!;
    f.mockImplementation(async (input: URL | RequestInfo, init?: RequestInit) =>
      String(input).endsWith("/gateway") && (init?.method ?? "GET") === "GET"
        ? new Response(JSON.stringify({ detail: "kaputt" }), { status: 502 })
        : orig(input, init));
    fireEvent.click(card("gateway").getByRole("button", { name: "Ergebnis prüfen" }));
    expect(await card("gateway").findByRole("alert")).toHaveTextContent(/kaputt|Dashboard/);
  });

  it("sends no POST/PUT/DELETE on open or on any check", async () => {
    await open();
    for (const b of screen.getAllByRole("button", { name: "Ergebnis prüfen" })) fireEvent.click(b);
    await waitFor(() => expect(screen.getAllByRole("status").length + screen.queryAllByRole("alert").length).toBeGreaterThan(0));
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("entries without a read route link to the page that shows the result", async () => {
    await open();
    const env = card("env");
    expect(env.queryByRole("button", { name: "Ergebnis prüfen" })).toBeNull();
    expect(env.getByRole("link", { name: "/providers" })).toBeInTheDocument();
  });

  it("commands render as plain text in code, never as HTML", async () => {
    await open();
    for (const e of GUIDE) expect(card(e.id).getByText(e.command).tagName.toLowerCase()).toBe("code");
  });

  it("commands are the verified ones (no invented subcommands)", () => {
    expect(GUIDE.map((e) => e.command)).toEqual([
      "hermes whatsapp", "hermes setup terminal", "hermes tools post-setup <schlüssel>", "hermes computer-use install",
      "hermes update --check", "hermes gateway migrate --dry-run", "hermes hooks list", "hermes config env-path",
      "hermes config edit", "hermes memory setup",
    ]);
  });

  it("route /guide opens the page and the menu links exist", async () => {
    await open();
    expect(screen.getAllByRole("link", { name: /Anleitungen/ }).length).toBeGreaterThanOrEqual(1);
  });
});
