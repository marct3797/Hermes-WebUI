import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
beforeEach(() => { resetRedirect(); sessionStorage.clear(); vi.spyOn(window, "confirm").mockReturnValue(true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const GO = "/h/server/hermes/gamma/sprache";
const upload = (size: number, type_: string) => fireEvent.change(screen.getByLabelText("Aufnahme"), { target: { files: [new File([new Uint8Array(size)], "a.webm", { type: type_ })] } });
describe("Sprache", () => {
  it("shows the status and reads text aloud", async () => {
    await open(GO, "Sprache");
    await screen.findByText(/Live-Sprache: chained/);
    type("Vorlesetext", "Hallo");
    fireEvent.click(screen.getByRole("button", { name: "Vorlesen" }));
    await screen.findByLabelText("Wiedergabe");
    expect(sent("POST", "/hermes-voice/speak")[0].body).toEqual({ text: "Hallo" });
  });

  it("refuses recordings that are too large or not audio before sending anything", async () => {
    await open(GO, "Sprache");
    await screen.findByText(/Live-Sprache/);
    upload(1_400_001, "audio/webm");
    await screen.findByText(/Aufnahme zu groß/);
    expect(screen.getByRole("button", { name: "Abschrift erstellen" })).toBeDisabled();
    upload(10, "application/pdf");
    await screen.findByText(/Nur Audiodateien/);
    expect(screen.getByRole("button", { name: "Abschrift erstellen" })).toBeDisabled();
    expect(sent("POST", "/hermes-voice/transcribe")).toHaveLength(0);
  });

  it("transcribes a valid recording", async () => {
    await open(GO, "Sprache");
    await screen.findByText(/Live-Sprache/);
    upload(100, "audio/webm");
    fireEvent.click(screen.getByRole("button", { name: "Abschrift erstellen" }));
    await screen.findByText("Hallo Welt");
    expect(String((sent("POST", "/hermes-voice/transcribe")[0].body as { data_url: string }).data_url)).toMatch(/^data:audio\/webm;base64,/);
  });

  it("explains when no voice provider is set up", async () => {
    backend = installBackend(["gamma"]);
    backend.dash.p3.voiceOn = false;
    history.pushState(null, "", GO);
    render(<App />);
    await screen.findByText(/Kein Sprachanbieter eingerichtet/);
    expect(screen.getByRole("button", { name: "Vorlesen" })).toBeDisabled(); // leer, nicht wegen des Live-Status
    type("Vorlesetext", "Hallo");
    expect(screen.getByRole("button", { name: "Vorlesen" })).not.toBeDisabled(); // Live-Sprache aus sperrt Vorlesen nicht
  });
});
