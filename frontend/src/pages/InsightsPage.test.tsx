import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { installBackend } from "../test-backend";

let backend: ReturnType<typeof installBackend>;
async function open(path: string, heading: string) {
  backend = installBackend(["gamma"]);
  history.pushState(null, "", path);
  render(<App />);
  await screen.findByRole("heading", { name: heading, level: 1 });
}
const sent = (method: string, part: string) => backend.calls.filter((c) => c.method === method && c.url.includes(part));
beforeEach(() => { resetRedirect(); sessionStorage.clear(); vi.spyOn(window, "confirm").mockReturnValue(true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const GO = "/h/server/hermes/gamma/einblicke";
describe("System und Datenschutz", () => {
  it("shows system figures and the curator state", async () => {
    await open(GO, "System und Datenschutz");
    await screen.findByText(/Hermes 0.22.5 auf Linux/);
    await screen.findByText(/läuft; Intervall 168 Std/);
  });

  it("shows the computer use state and its checks, and offers no way to grant rights", async () => {
    await open(GO, "System und Datenschutz");
    await screen.findByText(/Bereit\. cua 1\.0/);
    expect(screen.getByRole("list", { name: "Prüfungen" }).textContent).toContain("display: fehlgeschlagen");
    expect(screen.queryByRole("button", { name: /Berechtigung|erteilen|grant/i })).toBeNull();
  });

  it("does not call it ready when the dashboard says it is not", async () => {
    backend = installBackend(["gamma"]);
    backend.dash.p3.cuNotReady = true;
    history.pushState(null, "", GO);
    render(<App />);
    await screen.findByText(/Nicht bereit\./);
  });

  it("says plainly when computer use is not installed", async () => {
    backend = installBackend(["gamma"]);
    backend.dash.p3.cuMissing = true;
    history.pushState(null, "", GO);
    render(<App />);
    await screen.findByText(/Nicht installiert\./);
  });

  it("only starts the curator after the user ticks the confirmation", async () => {
    await open(GO, "System und Datenschutz");
    const start = await screen.findByRole("button", { name: "Curator jetzt starten" });
    expect(start).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Curator-Lauf bestätigen"));
    fireEvent.click(screen.getByRole("button", { name: "Curator jetzt starten" }));
    await screen.findByLabelText("Curator-Protokoll");
    expect(sent("POST", "/hermes-curator/run")[0].body).toEqual({ confirm_archive: true });
  });

  it("pauses the curator and reads the state back", async () => {
    await open(GO, "System und Datenschutz");
    fireEvent.click(await screen.findByRole("button", { name: "Pausieren" }));
    await screen.findByText(/pausiert; Intervall/);
  });

  it("changes theme and font only through the listed options", async () => {
    await open(GO, "System und Datenschutz");
    fireEvent.change(await screen.findByLabelText("Theme"), { target: { value: "midnight" } });
    await waitFor(() => expect(sent("PUT", "/hermes-appearance/theme")).toHaveLength(1));
    expect((screen.getByLabelText("Theme") as HTMLSelectElement).value).toBe("midnight");
    expect(Array.from((screen.getByLabelText("Schrift") as HTMLSelectElement).options).map((o) => o.value)).toEqual(["theme", "inter"]);
  });

  it("never sends metrics without the explicit confirmation", async () => {
    await open(GO, "System und Datenschutz");
    fireEvent.click(await screen.findByRole("button", { name: "Nur lokal sammeln" }));
    const on = await screen.findByRole("button", { name: "Senden einschalten" });
    expect(on).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Senden bestätigen"));
    fireEvent.click(screen.getByRole("button", { name: "Senden einschalten" }));
    await screen.findByRole("button", { name: "Senden ausschalten" });
    expect(sent("PUT", "/hermes-privacy/metrics").at(-1)?.body).toEqual({ enabled: true, send: true, confirm_send: true });
    expect(sent("PUT", "/hermes-privacy/metrics")[0].body).toEqual({ enabled: true, send: false });
  });

  it("asks for a fresh login instead of failing silently", async () => {
    await open(GO, "System und Datenschutz");
    backend.dash.stepUp = true;
    fireEvent.click(await screen.findByRole("button", { name: "Pausieren" }));
    await screen.findByText(/erneut anmelden/i);
  });

  it("offers no consent buttons on a managed installation", async () => {
    backend = installBackend(["gamma"]);
    backend.dash.p3.metrics.managed = true;
    history.pushState(null, "", GO);
    render(<App />);
    await screen.findByText(/Diese Installation wird verwaltet/);
    expect(screen.queryByRole("button", { name: "Nur lokal sammeln" })).toBeNull();
  });
});
