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
