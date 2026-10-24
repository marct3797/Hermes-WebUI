import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { installBackend } from "../test-backend";

let calls: ReturnType<typeof installBackend>["calls"];

async function open(agents = ["gamma"]) {
  ({ calls } = installBackend(agents));
  history.pushState(null, "", "/system");
  render(<App />);
  await screen.findByRole("heading", { name: "System", level: 1 });
  await screen.findByRole("region", { name: `Server ${agents[0]}` }); // erst wenn die Hosts geladen sind
}

beforeEach(() => resetRedirect());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("System", () => {
  it("is not checked until asked, and says so", async () => {
    await open();
    expect(screen.getByText("noch nicht geprüft")).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith("/diagnose"))).toBe(false);
  });

  it("checks every reachable agent with one click and shows the result per check", async () => {
    await open(["gamma", "eta"]);
    fireEvent.click(screen.getByRole("button", { name: /Alle prüfen/ }));
    await screen.findAllByText("Erreichbar und angemeldet");
    expect(calls.filter((c) => c.method === "GET" && c.url.endsWith("/diagnose")).map((c) => c.url)).toEqual([
      "/bff/h/server/hermes/gamma/diagnose", "/bff/h/server/hermes/eta/diagnose",
    ]); // der Laptop ist nicht erreichbar und bleibt außen vor
    const card = screen.getByRole("region", { name: "Server gamma" });
    expect(within(card).getByText("Version 0.21.6")).toBeInTheDocument();
    expect(within(card).getAllByRole("img", { name: "in Ordnung" })).toHaveLength(2);
    expect(screen.getByText("2 in Ordnung · 0 Abweichungen · 0 Fehler")).toBeInTheDocument(); // je Agent ein Bericht
  });

  it("runs the live test only on request and keeps the read-only results next to it", async () => {
    await open();
    const card = () => within(screen.getByRole("region", { name: "Server gamma" }));
    fireEvent.click(card().getByRole("button", { name: "Prüfen" }));
    await screen.findByText("Modelle und Anbieter");
    fireEvent.click(card().getByRole("button", { name: "Lauftest" }));
    await screen.findByText("Ereignisstrom bis zum Abschluss");
    expect(screen.getByText("Modelle und Anbieter")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Abweichung" })).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/diagnose/run"))).toHaveLength(1);
  });

  it("shows an error when the check itself cannot be fetched", async () => {
    await open();
    const f = vi.mocked(globalThis.fetch);
    const orig = f.getMockImplementation()!;
    f.mockImplementation(async (input: URL | RequestInfo, init?: RequestInit) => (String(input).endsWith("/diagnose") ? new Response(JSON.stringify({ detail: "Hermes nicht erreichbar" }), { status: 502 }) : orig(input, init)));
    fireEvent.click(within(screen.getByRole("region", { name: "Server gamma" })).getByRole("button", { name: "Prüfen" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Hermes nicht erreichbar"));
  });

  it("checks at most 4 agents at once and shows each result as soon as it arrives", async () => {
    await open(["a1", "a2", "a3", "a4", "a5", "a6"]);
    const f = vi.mocked(globalThis.fetch);
    const orig = f.getMockImplementation()!;
    const pending: Array<() => void> = [];
    let live = 0, peak = 0;
    f.mockImplementation(async (input: URL | RequestInfo, init?: RequestInit) => {
      if (!String(input).endsWith("/diagnose")) return orig(input, init);
      live++; peak = Math.max(peak, live);
      await new Promise<void>((r) => pending.push(r));
      live--;
      return orig(input, init);
    });
    fireEvent.click(screen.getByRole("button", { name: /Alle prüfen/ }));
    await waitFor(() => expect(pending).toHaveLength(4));
    expect(live).toBe(4);
    pending[0](); // einer fertig: der fünfte startet, das erste Ergebnis steht schon da
    await waitFor(() => expect(pending).toHaveLength(5));
    await within(screen.getByRole("region", { name: "Server a1" })).findByText("Version 0.21.6");
    expect(screen.queryByText("1 in Ordnung · 0 Abweichungen · 0 Fehler")).toBeInTheDocument();
    pending.slice(1).forEach((r) => r());
    await waitFor(() => expect(pending).toHaveLength(6));
    pending[5]();
    await screen.findByText("6 in Ordnung · 0 Abweichungen · 0 Fehler");
    expect(peak).toBe(4);
  });

  it("marks a check that hit the time limit as slow, not as failed", async () => {
    await open();
    const f = vi.mocked(globalThis.fetch);
    const orig = f.getMockImplementation()!;
    f.mockImplementation(async (input: URL | RequestInfo, init?: RequestInit) => (String(input).endsWith("/diagnose")
      ? new Response(JSON.stringify({ agent: "gamma", status: "warn", at: 1, checks: [{ id: "models", label: "Modelle und Anbieter", status: "slow", detail: "Langsam: keine Antwort nach 8 s", ms: 8001 }] }))
      : orig(input, init)));
    fireEvent.click(within(screen.getByRole("region", { name: "Server gamma" })).getByRole("button", { name: "Prüfen" }));
    expect(await screen.findByRole("img", { name: "langsam" })).toBeInTheDocument();
    expect(screen.getByText("0 in Ordnung · 1 Abweichungen · 0 Fehler")).toBeInTheDocument();
  });
});
