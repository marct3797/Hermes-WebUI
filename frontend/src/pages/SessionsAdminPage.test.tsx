import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

beforeEach(() => { resetRedirect(); sessionStorage.clear(); });
afterEach(() => { cleanup(); });

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
});
