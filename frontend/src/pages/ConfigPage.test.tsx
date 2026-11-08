import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { installBackend } from "../test-backend";

let backend: ReturnType<typeof installBackend>;
async function open() {
  backend = installBackend(["gamma"]);
  history.pushState(null, "", "/h/server/hermes/gamma/config");
  render(<App />);
  await screen.findByRole("heading", { name: "Hermes-Einstellungen", level: 1 });
  await screen.findByLabelText("Default model");
}
const puts = () => backend.calls.filter((c) => c.method === "PUT" && c.url.endsWith("/config"));
const save = () => screen.getByRole("button", { name: /Änderungen speichern/ });

beforeEach(() => { resetRedirect(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Hermes-Einstellungen", () => {
  it("shows the fields of the chosen area with an editor that fits each type", async () => {
    await open();
    expect(screen.getByLabelText("Default model")).toHaveValue("claude-test");
    expect(screen.queryByLabelText("Max turns")).not.toBeInTheDocument(); // anderer Bereich
    fireEvent.click(screen.getByRole("tab", { name: "agent" }));
    expect(screen.getByLabelText("Max turns")).toHaveValue(90);
    expect(screen.getByLabelText("Fast mode")).toHaveValue("normal");
    fireEvent.click(screen.getByRole("tab", { name: "display" }));
    expect(screen.getByLabelText("Streaming")).toBeChecked();
    expect(save()).toBeDisabled();
  });

  it("sends only what changed, then shows it as saved", async () => {
    await open();
    fireEvent.click(screen.getByRole("tab", { name: "agent" }));
    fireEvent.change(screen.getByLabelText("Max turns"), { target: { value: "40" } });
    fireEvent.change(screen.getByLabelText("Fast mode"), { target: { value: "fast" } });
    expect(save()).toHaveTextContent("2");
    fireEvent.click(save());
    await screen.findByText(/Gespeichert/);
    expect(puts()).toHaveLength(1);
    expect(puts()[0].body).toEqual({ changes: { "agent.max_turns": 40, "agent.service_tier": "fast" } });
    expect(save()).toBeDisabled();
  });

  it("keeps changes of other areas while you switch, and counts all of them", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Default model"), { target: { value: "anderes" } });
    fireEvent.click(screen.getByRole("tab", { name: "display" }));
    fireEvent.click(screen.getByLabelText("Streaming"));
    expect(save()).toHaveTextContent("2");
    fireEvent.click(save());
    await screen.findByText(/Gespeichert/);
    expect(puts()[0].body).toEqual({ changes: { model: "anderes", "display.streaming": false } });
  });

  it("edits lists as JSON and refuses invalid JSON before sending", async () => {
    await open();
    const list = screen.getByLabelText("Fallback providers");
    fireEvent.change(list, { target: { value: "[kaputt" } });
    expect(screen.getByText(/Kein gültiges JSON/)).toBeInTheDocument();
    expect(save()).toBeDisabled();
    fireEvent.change(list, { target: { value: '["a", "b"]' } });
    fireEvent.click(save());
    await screen.findByText(/Gespeichert/);
    expect(puts()[0].body).toEqual({ changes: { fallback_providers: ["a", "b"] } });
  });

  it("never offers secrets for editing and points to the keys page", async () => {
    await open();
    fireEvent.click(screen.getByRole("tab", { name: "tools" }));
    expect(screen.queryByLabelText("Search key")).not.toBeInTheDocument();
    const row = screen.getByText("Search key").closest("li") as HTMLElement;
    expect(within(row).getByText(/gesetzt/)).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: /Keys & Nutzung/ })).toHaveAttribute("href", "/h/server/hermes/gamma/providers");
  });

  it("finds a field across all areas by its text", async () => {
    await open();
    fireEvent.change(screen.getByRole("searchbox", { name: "Einstellung suchen" }), { target: { value: "max turns" } });
    expect(screen.getByLabelText("Max turns")).toBeInTheDocument();
    expect(screen.queryByLabelText("Default model")).not.toBeInTheDocument();
  });

  it("shows the server's reason when it refuses and keeps the draft", async () => {
    await open();
    fireEvent.click(screen.getByRole("tab", { name: "agent" }));
    fireEvent.change(screen.getByLabelText("Max turns"), { target: { value: "0" } });
    fireEvent.click(save());
    await screen.findByText(/ungültiger Wert/);
    expect(screen.getByLabelText("Max turns")).toHaveValue(0);
    expect(save()).toBeEnabled();
  });

  it("asks for a fresh login when the write needs one", async () => {
    await open();
    backend.dash.stepUp = true;
    fireEvent.change(screen.getByLabelText("Default model"), { target: { value: "x" } });
    fireEvent.click(save());
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(screen.queryByText(/Gespeichert/)).not.toBeInTheDocument();
  });

  it("says why when no dashboard is connected", async () => {
    backend = installBackend(["gamma"]);
    backend.dash.available = false;
    history.pushState(null, "", "/h/server/hermes/gamma/config");
    render(<App />);
    expect(await screen.findByText(/Dashboard nicht angebunden/)).toBeInTheDocument();
  });
});
