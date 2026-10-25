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
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
beforeEach(() => { resetRedirect(); sessionStorage.clear(); vi.spyOn(window, "confirm").mockReturnValue(true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const GO = "/h/server/hermes/gamma/endpunkte";
describe("Schlüssel-Pools", () => {
  it("shows only the last four characters and offers removal for manual entries only", async () => {
    await open(GO, "Eigene Endpunkte");
    await screen.findByText(/privat \(manual\) …abcd/);
    expect(screen.getByRole("button", { name: "Entfernen openrouter 1" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Entfernen openrouter 2" })).toBeNull();
    expect(screen.getByText(/nur über die Hermes-CLI entfernbar/)).toBeTruthy();
  });

  it("adds a key without ever showing it", async () => {
    await open(GO, "Eigene Endpunkte");
    await screen.findByText(/privat/);
    expect((screen.getByLabelText("Pool-Schlüssel") as HTMLInputElement).type).toBe("password");
    expect(screen.getByRole("button", { name: "Zum Pool hinzufügen" })).toBeDisabled();
    type("Pool-Anbieter", "Bad Name"); type("Pool-Schlüssel", "sk-geheim-1234");
    expect(screen.getByRole("button", { name: "Zum Pool hinzufügen" })).toBeDisabled();
    type("Pool-Anbieter", "anthropic");
    type("Pool-Schlüssel", "kurz");
    expect(screen.getByRole("button", { name: "Zum Pool hinzufügen" })).toBeDisabled();
    type("Pool-Schlüssel", "sk-geheim-1234");
    fireEvent.click(screen.getByRole("button", { name: "Zum Pool hinzufügen" }));
    await screen.findByText(/…1234/);
    expect(document.body.textContent).not.toContain("sk-geheim-1234");
    expect((screen.getByLabelText("Pool-Schlüssel") as HTMLInputElement).value).toBe("");
  });

  it("removes an entry only after typing the provider name", async () => {
    await open(GO, "Eigene Endpunkte");
    await screen.findByText(/privat/);
    type("Anbieter zum Entfernen openrouter 1", "openrouter");
    fireEvent.click(screen.getByRole("button", { name: "Entfernen openrouter 1" }));
    await waitFor(() => expect(screen.queryByText(/privat \(manual\)/)).toBeNull());
    expect(sent("DELETE", "/hermes-credentials/openrouter/1")[0].url).toContain("confirm=openrouter");
  });

  it("shows the real reason when Hermes is too old, not a claim that no dashboard exists", async () => {
    backend = installBackend(["gamma"]);
    backend.dash.p3.old501 = "Diese Hermes-Version kennt /api/credentials/pool nicht. Hermes aktualisieren (Mindestversion: docs/compatibility.md).";
    history.pushState(null, "", GO);
    render(<App />);
    await screen.findByText(/privat/);
    type("Pool-Anbieter", "anthropic"); type("Pool-Schlüssel", "sk-geheim-1234");
    fireEvent.click(screen.getByRole("button", { name: "Zum Pool hinzufügen" }));
    await screen.findByText(/Diese Hermes-Version kennt \/api\/credentials\/pool nicht/);
    expect(screen.queryByText(/kein Dashboard eingerichtet/)).toBeNull();
  });
});
