import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { installBackend } from "../test-backend";
import type { UiConfig } from "../types";

let calls: ReturnType<typeof installBackend>["calls"];

async function open(ui: Partial<UiConfig> = {}) {
  ({ calls } = installBackend(["raiden"], undefined, { ui: { backgroundShader: { enabled: true, strength: 1.6, speed: 1 } }, ...ui }));
  history.pushState(null, "", "/settings");
  render(<App />);
  await screen.findByRole("heading", { name: "Darstellung", level: 1 });
}
const local = () => JSON.parse(localStorage.getItem("hermes.shader") ?? "null");

beforeEach(() => { resetRedirect(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Darstellung", () => {
  it("shows the default of the WebUI and switches the shader for this device", async () => {
    await open();
    expect(screen.getByText(/Vorgabe der WebUI: Stärke 1,6 · Tempo 1,0/)).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Shader an" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Shader aus" })).toHaveAttribute("aria-pressed", "false");
    expect(local()).toEqual({ enabled: false });
    expect(screen.getByLabelText("Stärke")).toBeDisabled();
    expect(screen.getByText(/Auf diesem Gerät gilt eine eigene Einstellung/)).toBeInTheDocument();
  });

  it("remembers strength and tempo on this device and resets to the default", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Stärke"), { target: { value: "2.4" } });
    fireEvent.change(screen.getByLabelText("Tempo"), { target: { value: "0.5" } });
    expect(local()).toEqual({ strength: 2.4, speed: 0.5 });
    expect(screen.getByText("2,4")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Auf Vorgabe zurücksetzen/ }));
    expect(local()).toBeNull();
    expect(screen.getByLabelText("Stärke")).toHaveValue("1.6");
    expect(screen.getByRole("button", { name: /Auf Vorgabe zurücksetzen/ })).toBeDisabled();
  });

  it("ignores broken values stored on the device", async () => {
    localStorage.setItem("hermes.shader", JSON.stringify({ enabled: "ja", strength: 99, speed: -1 }));
    await open();
    expect(screen.getByLabelText("Stärke")).toHaveValue("1.6");
    expect(screen.getByRole("button", { name: "Shader an" })).toBeInTheDocument();
  });

  it("saves the current values as the default for all devices when the config is writable", async () => {
    await open({ writable: true, write_error: null });
    const saveBtn = screen.getByRole("button", { name: /Als Vorgabe für alle Geräte speichern/ });
    expect(saveBtn).toBeDisabled(); // noch gleich der Vorgabe
    fireEvent.change(screen.getByLabelText("Stärke"), { target: { value: "2.5" } });
    expect(saveBtn).toBeEnabled();
    fireEvent.click(saveBtn);
    await screen.findByText("Gespeichert");
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({ url: "/bff/ui/shader", body: { enabled: true, strength: 2.5, speed: 1 } });
    expect(local()).toBeNull(); // das Gerät folgt jetzt der gespeicherten Vorgabe
    expect(screen.getByText(/Vorgabe der WebUI: Stärke 2,5/)).toBeInTheDocument();
  });

  it("explains why the default cannot be saved when the config is read-only", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Stärke"), { target: { value: "2.5" } });
    const btn = screen.getByRole("button", { name: /Als Vorgabe für alle Geräte speichern/ });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", "Die ui.json ist für die WebUI schreibgeschützt.");
    expect(screen.getByText(/ui.backgroundShader/)).toBeInTheDocument();
  });

  it("says so when the system asks for less motion and on narrow screens", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: true, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    await open();
    expect(screen.getByText(/„Bewegung reduzieren“ ist im System an/)).toBeInTheDocument();
    expect(screen.getByText(/Auf schmalen Schirmen ist der Shader aus/)).toBeInTheDocument();
  });

  it("is reachable from the sidebar", async () => {
    installBackend(["raiden"]);
    history.pushState(null, "", "/");
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Darstellung" }));
    await waitFor(() => expect(location.pathname).toBe("/settings"));
    expect(await screen.findByRole("heading", { name: "Darstellung", level: 1 })).toBeInTheDocument();
  });
});
