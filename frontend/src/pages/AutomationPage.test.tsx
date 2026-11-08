import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { installBackend } from "../test-backend";

beforeEach(() => { resetRedirect(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function open() {
  const backend = installBackend(["gamma"]);
  history.pushState(null, "", "/h/server/hermes/gamma/automation");
  render(<App />);
  await screen.findByRole("heading", { name: "Ziele und Schleifen", level: 1 });
  return backend;
}
const posts = (b: ReturnType<typeof installBackend>) => b.calls.filter((c) => c.method === "POST" && c.url.endsWith("/automation"));

describe("Ziele und Schleifen", () => {
  it("zeigt Ziel und Heartbeat samt Zustand", async () => {
    const backend = await open();
    expect(await screen.findByText("Alle Tests grün")).toBeTruthy();
    expect(screen.getByText(/3 von 20 Runden/)).toBeTruthy();
    expect(screen.getByText("ruff sauber")).toBeTruthy();
    expect(screen.getByText("CI prüfen")).toBeTruthy();
    expect(screen.getByText("pausiert")).toBeTruthy();
    expect(screen.getByText("Keine Schleifen aktiv.")).toBeTruthy();
    expect(posts(backend)).toHaveLength(0);
  });

  it("pausiert ein Ziel und setzt den pausierten Heartbeat fort", async () => {
    const backend = await open();
    await screen.findByText("Alle Tests grün");
    fireEvent.click(screen.getByRole("button", { name: "Pausieren" }));
    await waitFor(() => expect(screen.getAllByText("pausiert")).toHaveLength(2));
    fireEvent.click(screen.getAllByRole("button", { name: "Fortsetzen" })[1]);
    await waitFor(() => expect(posts(backend)).toHaveLength(2));
    expect(posts(backend).map((c) => (c.body as { kind: string; action: string }))).toEqual([
      { session_id: "s1", kind: "goal", action: "pause" }, { session_id: "s1", kind: "heartbeat", action: "resume" }]);
  });

  it("löscht erst nach einer zweiten Bestätigung", async () => {
    const backend = await open();
    await screen.findByText("CI prüfen");
    fireEvent.click(screen.getAllByRole("button", { name: "Löschen" })[1]);
    expect(posts(backend)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Löschen" })[1]);
    fireEvent.click(screen.getByRole("button", { name: "Ja, löschen" }));
    await waitFor(() => expect(screen.queryByText("CI prüfen")).toBeNull());
    expect(posts(backend)).toHaveLength(1);
  });

  it("setzt ein neues Ziel für eine Sitzung und warnt vor dem Ersetzen", async () => {
    const backend = await open();
    await screen.findByText("Alle Tests grün");
    const save = screen.getByRole("button", { name: "Setzen" });
    expect(save).toBeDisabled();
    await waitFor(() => expect((screen.getByLabelText("Sitzung") as HTMLSelectElement).value).not.toBe(""));
    expect(screen.queryByText(/schon ein Ziel/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Ziel-Text"), { target: { value: "Release ausliefern" } });
    fireEvent.change(screen.getByLabelText("Höchstzahl Runden"), { target: { value: "0" } });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Höchstzahl Runden"), { target: { value: "15" } });
    fireEvent.click(save);
    await waitFor(() => expect(posts(backend)).toHaveLength(1));
    const sent = posts(backend)[0].body as Record<string, unknown>;
    expect(sent).toMatchObject({ kind: "goal", action: "set", text: "Release ausliefern", max_turns: 15 });
    expect(typeof sent.session_id).toBe("string");
    expect(await screen.findByText("Ziel gesetzt. Hermes arbeitet jetzt daran.")).toBeTruthy();
  });

  it("setzt einen Heartbeat mit Intervall in Sekunden", async () => {
    const backend = await open();
    await screen.findByText("Alle Tests grün");
    fireEvent.change(screen.getByLabelText("Art"), { target: { value: "heartbeat" } });
    fireEvent.change(screen.getByLabelText("Heartbeat-Text"), { target: { value: "Deploy beobachten" } });
    fireEvent.change(screen.getByLabelText("Intervall in Minuten"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Setzen" }));
    await waitFor(() => expect(posts(backend)).toHaveLength(1));
    expect(posts(backend)[0].body).toMatchObject({ kind: "heartbeat", action: "set", text: "Deploy beobachten", interval_seconds: 300 });
  });

  it("verlangt für Änderungen eine frische Anmeldung", async () => {
    const backend = await open();
    await screen.findByText("Alle Tests grün");
    backend.dash.stepUp = true;
    fireEvent.click(screen.getByRole("button", { name: "Pausieren" }));
    expect(await screen.findByText(/erneut anmelden|frische Anmeldung|Anmeldung/i)).toBeTruthy();
    expect(screen.queryByText("aktiv")).toBeTruthy();
  });
});
