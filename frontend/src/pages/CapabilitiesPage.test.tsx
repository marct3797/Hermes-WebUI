import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { installBackend } from "../test-backend";

beforeEach(() => resetRedirect());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Skills und Werkzeuge", () => {
  it("lists skills and filters by category and text", async () => {
    installBackend();
    history.pushState(null, "", "/h/hikari/hermes/raiden/skills");
    render(<App />);
    await screen.findByRole("heading", { name: "Skills", level: 1 });
    expect(await screen.findByText("Zerlegt Aufgaben in Schritte.")).toBeInTheDocument();
    expect(screen.getByText("raiden · 2 installiert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "email" }));
    expect(screen.queryByText("plan")).not.toBeInTheDocument();
    expect(screen.getByText("himalaya")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Alle" }));
    fireEvent.change(screen.getByLabelText("Skills durchsuchen"), { target: { value: "zerlegt" } });
    expect(screen.queryByText("himalaya")).not.toBeInTheDocument();
    expect(screen.getByText("plan")).toBeInTheDocument();
  });

  it("says where the list comes from when Hermes could not list the skills and the dashboard stepped in", async () => {
    installBackend();
    const backend = globalThis.fetch;
    const rows = [{ name: "plan", description: "Zerlegt Aufgaben.", category: "software-development", enabled: true, provenance: "bundled" }, { name: "mein-skill", enabled: true, provenance: "agent" }];
    vi.stubGlobal("fetch", (url: RequestInfo | URL, init?: RequestInit) => String(url).endsWith("/raiden/skills")
      ? Promise.resolve(new Response(JSON.stringify({ object: "list", data: rows, source: "dashboard", note: "Die Agent-API konnte die Liste nicht liefern (Failed to enumerate skills); sie kommt aus dem Dashboard." }), { headers: { "content-type": "application/json" } }))
      : backend(url, init));
    history.pushState(null, "", "/h/hikari/hermes/raiden/skills");
    render(<App />);
    expect(await screen.findByText(/Failed to enumerate skills\); sie kommt aus dem Dashboard/)).toBeInTheDocument();
    expect(screen.getByText("mitgeliefert")).toBeInTheDocument();
    expect(screen.getByText("selbst erstellt")).toBeInTheDocument();
    expect(screen.queryByText(/Skills nicht ladbar/)).not.toBeInTheDocument();
  });

  it("shows toolsets with their state, and flags those that are not set up", async () => {
    installBackend();
    history.pushState(null, "", "/h/hikari/hermes/raiden/tools");
    render(<App />);
    await screen.findByRole("heading", { name: "Werkzeuge", level: 1 });
    expect(await screen.findByText("Terminal")).toBeInTheDocument();
    expect(screen.getByText("raiden · 2 von 3 aktiv")).toBeInTheDocument();
    expect(screen.getByText("nicht eingerichtet")).toBeInTheDocument();
    expect(screen.getByText("aus")).toBeInTheDocument();
  });

  it("is reachable from the chat's session column", async () => {
    installBackend();
    history.pushState(null, "", "/h/hikari/hermes/raiden");
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Skills von raiden" }));
    await screen.findByRole("heading", { name: "Skills", level: 1 });
  });
});
