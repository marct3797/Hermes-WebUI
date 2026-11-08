import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { installBackend } from "../test-backend";

beforeEach(() => { resetRedirect(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Ziele und Schleifen", () => {
  it("zeigt Ziel und Heartbeat samt Zustand und sagt, dass es nur eine Ansicht ist", async () => {
    const backend = installBackend(["gamma"]);
    history.pushState(null, "", "/h/server/hermes/gamma/automation");
    render(<App />);
    await screen.findByRole("heading", { name: "Ziele und Schleifen", level: 1 });
    expect(await screen.findByText("Alle Tests grün")).toBeTruthy();
    expect(screen.getByText(/3 von 20 Runden/)).toBeTruthy();
    expect(screen.getByText("ruff sauber")).toBeTruthy();
    expect(screen.getByText("CI prüfen")).toBeTruthy();
    expect(screen.getByText("pausiert")).toBeTruthy();
    expect(screen.getByText("Keine Schleifen aktiv.")).toBeTruthy();
    expect(screen.getByText(/Nur Ansicht/)).toBeTruthy();
    expect(backend.calls.filter((c) => c.method !== "GET" && c.url.includes("/automation"))).toHaveLength(0);
  });
});
