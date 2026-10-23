import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { installBackend } from "../test-backend";

let calls: ReturnType<typeof installBackend>["calls"];

async function open(agents = ["raiden"]) {
  ({ calls } = installBackend(agents));
  history.pushState(null, "", "/system");
  render(<App />);
  await screen.findByRole("heading", { name: "System", level: 1 });
  await screen.findByRole("region", { name: `Hikari ${agents[0]}` }); // erst wenn die Hosts geladen sind
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
    await open(["raiden", "sora"]);
    fireEvent.click(screen.getByRole("button", { name: /Alle prüfen/ }));
    await screen.findAllByText("Erreichbar und angemeldet");
    expect(calls.filter((c) => c.method === "GET" && c.url.endsWith("/diagnose")).map((c) => c.url)).toEqual([
      "/bff/h/hikari/hermes/raiden/diagnose", "/bff/h/hikari/hermes/sora/diagnose",
    ]); // der Laptop ist nicht erreichbar und bleibt außen vor
    const card = screen.getByRole("region", { name: "Hikari raiden" });
    expect(within(card).getByText("Version 0.21.6")).toBeInTheDocument();
    expect(within(card).getAllByRole("img", { name: "in Ordnung" })).toHaveLength(2);
    expect(screen.getByText("2 in Ordnung · 0 Abweichungen · 0 Fehler")).toBeInTheDocument(); // je Agent ein Bericht
  });

  it("runs the live test only on request and keeps the read-only results next to it", async () => {
    await open();
    const card = () => within(screen.getByRole("region", { name: "Hikari raiden" }));
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
    const f = globalThis.fetch as ReturnType<typeof vi.fn>;
    const orig = f.getMockImplementation()!;
    f.mockImplementation(async (url: string, init?: RequestInit) => (String(url).endsWith("/diagnose") ? new Response(JSON.stringify({ detail: "Hermes nicht erreichbar" }), { status: 502 }) : orig(url, init)));
    fireEvent.click(within(screen.getByRole("region", { name: "Hikari raiden" })).getByRole("button", { name: "Prüfen" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Hermes nicht erreichbar"));
  });
});
