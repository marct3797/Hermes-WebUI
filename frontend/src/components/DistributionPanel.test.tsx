import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { installBackend } from "../test-backend";

let backend: ReturnType<typeof installBackend>;
async function open(prepare?: (b: ReturnType<typeof installBackend>) => void) {
  backend = installBackend(["gamma"]);
  prepare?.(backend);
  history.pushState(null, "", "/h/server/hermes/gamma/lebenszyklus");
  render(<App />);
  return await screen.findByRole("region", { name: "Distributionen" });
}
beforeEach(() => { resetRedirect(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Distributionen", () => {
  it("zeigt erst die Vorschau und installiert nur mit dem eingetippten Namen", async () => {
    const panel = await open();
    const p = within(panel);
    await p.findByLabelText("Quelle");
    const preview = p.getByRole("button", { name: "Vorschau laden" });
    expect(preview).toBeDisabled();
    fireEvent.change(p.getByLabelText("Name des neuen Profils"), { target: { value: "Scout" } });
    fireEvent.click(preview);
    expect(await p.findByText(/Enthält mcp.json/)).toBeTruthy();
    expect(p.getByText("2 Dateien")).toBeTruthy();
    const install = p.getByRole("button", { name: "Installieren" });
    expect(install).toBeDisabled();
    expect(backend.dash.dist.installs).toHaveLength(0);
    fireEvent.change(p.getByLabelText("Zum Bestätigen den Profilnamen eintippen"), { target: { value: "scout" } });
    fireEvent.click(install);
    await p.findByText(/scout 1.2.0 ist installiert/);
    expect(backend.dash.dist.installs).toEqual([{ action: "install", source_id: "team", name: "scout", digest: "a".repeat(64), confirm: "scout", force: false }]);
    expect(p.queryByRole("group", { name: "Vorschau" })).toBeNull();
  });

  it("verlangt für ein vorhandenes Profil das Überschreiben ausdrücklich und verwirft die Vorschau bei Änderungen", async () => {
    const panel = await open((b) => { b.dash.dist.existing = true; });
    const p = within(panel);
    await p.findByLabelText("Quelle");
    fireEvent.change(p.getByLabelText("Name des neuen Profils"), { target: { value: "scout" } });
    fireEvent.click(p.getByRole("button", { name: "Vorschau laden" }));
    await p.findByText(/Enthält mcp.json/);
    expect(p.getByText(/Die config.yaml setzt: hooks/)).toBeTruthy();
    expect(p.getByText(/Bringt weitere Ordner mit: plugins/)).toBeTruthy();
    expect(p.getByText(/Quelle: https:\/\/git.example.org/)).toBeTruthy();
    expect(p.getByText(/Dieses Profil ist keine Distribution/)).toBeTruthy();
    fireEvent.change(p.getByLabelText("Zum Bestätigen den Profilnamen eintippen"), { target: { value: "scout" } });
    expect(p.getByRole("button", { name: "Installieren" })).toBeDisabled();
    fireEvent.click(p.getByLabelText(/Vorhandenes Profil überschreiben/));
    expect(p.getByRole("button", { name: "Installieren" })).not.toBeDisabled();
    fireEvent.change(p.getByLabelText("Name des neuen Profils"), { target: { value: "scout2" } });
    expect(p.queryByRole("group", { name: "Vorschau" })).toBeNull();
  });

  it("aktualisiert ein Profil und nennt den fehlenden Schalter oder die fehlende Quelle", async () => {
    const panel = await open();
    const p = within(panel);
    await p.findByLabelText("Quelle");
    fireEvent.change(p.getByLabelText("Vorgang"), { target: { value: "update" } });
    fireEvent.change(p.getByLabelText("Profil der Distribution"), { target: { value: "scout" } });
    fireEvent.click(p.getByRole("button", { name: "Vorschau laden" }));
    await p.findByText(/Enthält mcp.json/);
    fireEvent.change(p.getByLabelText("Zum Bestätigen den Profilnamen eintippen"), { target: { value: "scout" } });
    fireEvent.click(p.getByRole("button", { name: "Aktualisieren" }));
    await waitFor(() => expect(backend.dash.dist.installs[0]).toMatchObject({ action: "update", profile: "scout", force_config: false }));
    cleanup();
    const off = within(await open((b) => { b.dash.dist.off = true; }));
    expect(await off.findByText(/allow_distributions/)).toBeTruthy();
  });

  it("weist auf fehlende Quellen hin", async () => {
    const panel = await open((b) => { b.dash.dist.sources = []; });
    expect(await within(panel).findByText(/distribution_sources/)).toBeTruthy();
  });
});
