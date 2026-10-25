import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

beforeEach(() => resetRedirect());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("GuidePage", () => {
  it("renders every entry with title, command and warning", async () => {
    await open();
    expect(GUIDE.length).toBeGreaterThanOrEqual(8);
    for (const e of GUIDE) {
      expect(screen.getByText(e.title)).toBeInTheDocument();
      expect(screen.getByText(e.command)).toBeInTheDocument();
      expect(screen.getByText(e.caution)).toBeInTheDocument();
    }
  });

  it("copies the command to the clipboard", async () => {
    await open();
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: write } });
    const cards = screen.getAllByRole("button", { name: "Befehl kopieren" });
    fireEvent.click(cards[0]);
    await waitFor(() => expect(write).toHaveBeenCalledWith(GUIDE[0].command));
  });

  it("check calls the recorded read route and shows success and failure", async () => {
    await open();
    // WhatsApp-Eintrag: Messaging-Route aufrufen, Erfolg zeigen.
    const checks = screen.getAllByRole("button", { name: "Ergebnis pruefen" });
    fireEvent.click(checks[0]);
    await screen.findByText("Telegram: disabled");
    expect(calls.some((c) => c.method === "GET" && c.url.endsWith("/messaging"))).toBe(true);
    // Gateway-Eintrag: Fehler vom Dashboard wird sichtbar, nichts verschluckt.
    const f = vi.mocked(globalThis.fetch);
    const orig = f.getMockImplementation()!;
    f.mockImplementation(async (input: URL | RequestInfo, init?: RequestInit) =>
      String(input).endsWith("/gateway") && (init?.method ?? "GET") === "GET"
        ? new Response(JSON.stringify({ detail: "kaputt" }), { status: 502 })
        : orig(input, init));
    const gw = GUIDE.findIndex((e) => e.id === "gateway");
    fireEvent.click(screen.getAllByRole("button", { name: "Ergebnis pruefen" })[gw]);
    await screen.findByRole("alert");
  });

  it("sends no POST/PUT/DELETE on open or on check", async () => {
    await open();
    for (const b of screen.getAllByRole("button", { name: "Ergebnis pruefen" })) fireEvent.click(b);
    await screen.findAllByText(/Backend|Gateway|Speicher|Modelle|MCP-Server|Hooks|Werkzeug|Dashboard|WhatsApp/);
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("commands render as plain text in code, never as HTML", async () => {
    await open();
    for (const e of GUIDE) {
      const node = screen.getByText(e.command);
      expect(node.tagName.toLowerCase()).toBe("code");
    }
    expect(document.body.innerHTML).not.toContain("dangerouslySetInnerHTML");
  });

  it("route /guide opens the page and the menu links exist", async () => {
    await open();
    expect(screen.getByRole("heading", { name: "Anleitungen", level: 1 })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Anleitungen/ }).length).toBeGreaterThanOrEqual(1);
  });

  it("mutation probe: wrong check route breaks the test", async () => {
    await open();
    // Kernlogik kaputt machen: Gateway-Pruefung ruft die falsche Route.
    const gw = GUIDE.find((e) => e.id === "gateway")!;
    const orig = gw.run!;
    gw.run = async () => ({ ok: true, text: "FALSCH" });
    const idx = GUIDE.findIndex((e) => e.id === "gateway");
    fireEvent.click(screen.getAllByRole("button", { name: "Ergebnis pruefen" })[idx]);
    await screen.findByText("FALSCH");
    expect(calls.some((c) => c.method === "GET" && c.url.endsWith("/gateway"))).toBe(false);
    gw.run = orig;
  });
});
