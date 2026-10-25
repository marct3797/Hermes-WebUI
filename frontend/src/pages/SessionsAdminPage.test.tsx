import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { installBackend } from "../test-backend";

let backend: ReturnType<typeof installBackend>;
async function open() {
  backend = installBackend(["gamma"]);
  history.pushState(null, "", "/h/server/hermes/gamma/sitzungen-verwalten");
  render(<App />);
  await screen.findByRole("heading", { name: "Sitzungen verwalten", level: 1 });
}
const sent = (method: string, part: string) => backend.calls.filter((c) => c.method === method && c.url.includes(part));
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => { resetRedirect(); sessionStorage.clear(); vi.spyOn(window, "confirm").mockReturnValue(true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Sitzungen verwalten", () => {
  it("shows the store statistics", async () => {
    await open();
    await screen.findByText(/5 Sitzungen, 10 Nachrichten/);
  });

  it("deletes old sessions only after preview and typing the shown count", async () => {
    await open();
    await screen.findByText(/5 Sitzungen/);
    const del = () => screen.getByRole("button", { name: "Jetzt löschen" });
    fireEvent.click(screen.getByRole("button", { name: "Vorschau" }));
    await screen.findByText(/2 Sitzungen würden gelöscht, 1 laufende bleiben/);
    expect(del()).toBeDisabled();
    type("Anzahl bestätigen", "3");
    expect(del()).toBeDisabled();
    type("Anzahl bestätigen", "2");
    fireEvent.click(del());
    await screen.findByText(/2 Sitzungen gelöscht/);
    await screen.findByText(/3 Sitzungen, /);
    expect(sent("POST", "/hermes-sessions/prune")).toHaveLength(2); // Vorschau + Löschen
  });

  it("refuses an age of zero days in the browser", async () => {
    await open();
    await screen.findByText(/5 Sitzungen/);
    type("Älter als (Tage)", "0");
    expect(screen.getByRole("button", { name: "Vorschau" })).toBeDisabled();
    expect(sent("POST", "/hermes-sessions/prune/preview")).toHaveLength(0);
  });

  it("deletes empty sessions only after typing the count", async () => {
    await open();
    await screen.findByText(/1 leere, beendete Sitzungen/);
    const btn = () => screen.getByRole("button", { name: "Leere löschen" });
    expect(btn()).toBeDisabled();
    type("Leere bestätigen", "1");
    fireEvent.click(btn());
    await waitFor(() => expect(sent("DELETE", "confirm=1")).toHaveLength(1));
    await screen.findByText(/0 leere, beendete Sitzungen/);
  });

  it("offers no delete when nothing matches, even if 0 is typed", async () => {
    await open();
    await screen.findByText(/5 Sitzungen/);
    type("Älter als (Tage)", "1000");
    fireEvent.click(screen.getByRole("button", { name: "Vorschau" }));
    await screen.findByText(/0 Sitzungen würden gelöscht/);
    type("Anzahl bestätigen", "0");
    expect(screen.getByRole("button", { name: "Jetzt löschen" })).toBeDisabled();
    await screen.findByText(/1 leere, beendete Sitzungen/);
  });

  it("offers no empty delete when there are none, even if 0 is typed", async () => {
    await open();
    await screen.findByText(/1 leere, beendete Sitzungen/);
    type("Leere bestätigen", "1");
    fireEvent.click(screen.getByRole("button", { name: "Leere löschen" }));
    await screen.findByText(/0 leere, beendete Sitzungen/);
    type("Leere bestätigen", "0");
    expect(screen.getByRole("button", { name: "Leere löschen" })).toBeDisabled();
  });

  it("shows why the store cannot be read instead of loading forever", async () => {
    backend = installBackend(["gamma"]);
    backend.dash.sa.down = true;
    history.pushState(null, "", "/h/server/hermes/gamma/sitzungen-verwalten");
    render(<App />);
    await screen.findByRole("heading", { name: "Sitzungen verwalten", level: 1 });
    expect((await screen.findByRole("alert")).textContent).toContain("Session store is not initialized");
  });

  it("loads the timeline of a session", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Sitzungs-ID"), { target: { value: "a1" } });
    fireEvent.click(screen.getByRole("button", { name: "Zeitachse laden" }));
    await screen.findByText("Hallo");
    expect(sent("GET", "/hermes-sessions/a1/timeline")).toHaveLength(1);
  });

  it("imports sessions only after typing the shown count", async () => {
    await open();
    const payload = JSON.stringify({ sessions: [{ id: "n1", title: "Neu", messages: [] }] });
    const origText = File.prototype.text;
    try {
      File.prototype.text = () => Promise.resolve(payload); // jsdom-File kennt .text() nicht, Browser schon
      const file = new File([payload], "export.json", { type: "application/json" });
      fireEvent.change(screen.getByLabelText("Exportdatei"), { target: { files: [file] } });
      await screen.findByText("1 Sitzungen in der Datei.");
      const btn = screen.getByRole("button", { name: "Jetzt importieren" });
      expect(btn).toBeDisabled();
      fireEvent.change(screen.getByLabelText("Anzahl bestätigen"), { target: { value: "2" } });
      expect(btn).toBeDisabled();
      fireEvent.change(screen.getByLabelText("Anzahl bestätigen"), { target: { value: "1" } });
      fireEvent.click(btn);
      await screen.findByText("1 Sitzungen importiert.");
      expect(sent("POST", "/hermes-sessions/import")[0].body).toEqual({ sessions: [{ id: "n1", title: "Neu", messages: [] }], confirm_count: 1 });
    } finally {
      File.prototype.text = origText;
    }
  });

  it("assigns old sessions to this profile", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Jetzt zuordnen" }));
    await screen.findByText("2 Sitzungen zugeordnet.");
    expect(sent("POST", "/hermes-sessions/owner-backfill")[0].body).toEqual({ confirm: true });
  });
});
