import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { installBackend } from "../test-backend";

let backend: ReturnType<typeof installBackend>;
async function open(prepare?: (b: ReturnType<typeof installBackend>) => void) {
  backend = installBackend(["gamma"]);
  prepare?.(backend);
  history.pushState(null, "", "/h/server/hermes/gamma/hermes-memory");
  render(<App />);
  await screen.findByRole("heading", { name: "Hermes-Gedächtnis", level: 1 });
}
const sent = (method: string, suffix: string) => backend.calls.filter((c) => c.method === method && c.url.endsWith(suffix));

beforeEach(() => { resetRedirect(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Hermes-Gedächtnis", () => {
  it("shows the built-in files by size only, and says the dashboard does not show their content", async () => {
    await open();
    const b = await screen.findByRole("region", { name: "Eingebautes Gedächtnis" });
    expect(within(b).getByText("MEMORY.md: 120 Bytes")).toBeInTheDocument();
    expect(within(b).getByText("USER.md: 45 Bytes")).toBeInTheDocument();
    expect(within(b).getByText(/Inhalt zeigt das Dashboard nicht/)).toBeInTheDocument();
  });

  it("names the program a provider is missing, but offers no way to install it", async () => {
    await open();
    const p = await screen.findByRole("region", { name: "Anbieter byterover" });
    expect(within(p).getByText(/Fehlt: brv/)).toBeInTheDocument();
    expect(within(p).getByText("curl -fsSL https://byterover.dev/install.sh | sh")).toBeInTheDocument();
    expect(within(p).queryByRole("button", { name: /Installieren|Aktivieren/ })).not.toBeInTheDocument();
  });

  it("sets up a provider without showing the key, sending only what changed, and activates it", async () => {
    await open();
    const p = await screen.findByRole("region", { name: "Anbieter retaindb" });
    fireEvent.click(within(p).getByRole("button", { name: "retaindb einrichten" }));
    const key = await within(p).findByLabelText("Api Key");
    expect(key).toHaveAttribute("type", "password");
    expect(key).toHaveAttribute("autocomplete", "off");
    expect(within(p).getByRole("button", { name: "Speichern" })).toBeDisabled();
    fireEvent.change(key, { target: { value: " rdb-geheim-1 " } });
    fireEvent.click(within(p).getByRole("button", { name: "Speichern" }));
    await within(p).findByText(/Gespeichert/);
    expect(sent("PUT", "/providers/retaindb")[0].body).toEqual({ values: { api_key: "rdb-geheim-1" } });
    expect(key).toHaveValue("");
    expect(document.body.textContent).not.toContain("rdb-geheim-1");
    expect(await within(p).findByText("aktiv", { selector: ".tag" })).toBeInTheDocument();
  });

  it("sends a changed select and text field, and nothing else", async () => {
    await open((b) => { b.dash.hm.keySet = true; });
    const p = await screen.findByRole("region", { name: "Anbieter retaindb" });
    fireEvent.click(within(p).getByRole("button", { name: "retaindb einrichten" }));
    fireEvent.change(await within(p).findByLabelText("Mode"), { target: { value: "deep" } });
    fireEvent.change(within(p).getByLabelText("Project"), { target: { value: "demo" } });
    fireEvent.click(within(p).getByRole("button", { name: "Speichern" }));
    await within(p).findByText(/Gespeichert/);
    expect(sent("PUT", "/providers/retaindb")[0].body).toEqual({ values: { project: "demo", mode: "deep" } });
  });

  it("shows why Hermes does not accept a provider", async () => {
    await open();
    const p = await screen.findByRole("region", { name: "Anbieter byterover" });
    fireEvent.click(within(p).getByRole("button", { name: "byterover einrichten" }));
    fireEvent.change(await within(p).findByLabelText("Auto Extract"), { target: { value: "false" } });
    fireEvent.click(within(p).getByRole("button", { name: "Speichern" }));
    expect(await within(p).findByRole("alert")).toHaveTextContent("not ready");
  });

  it("switches between a ready provider and the built-in memory", async () => {
    await open((b) => { b.dash.hm.keySet = true; });
    const p = await screen.findByRole("region", { name: "Anbieter retaindb" });
    fireEvent.click(within(p).getByRole("button", { name: "retaindb aktivieren" }));
    await within(p).findByText("aktiv", { selector: ".tag" });
    expect(sent("PUT", "/hermes-memory/provider")[0].body).toEqual({ provider: "retaindb" });
    fireEvent.click(within(p).getByRole("button", { name: "Eingebautes Gedächtnis verwenden" }));
    await waitFor(() => expect(within(p).queryByText("aktiv", { selector: ".tag" })).not.toBeInTheDocument());
    expect(sent("PUT", "/hermes-memory/provider")[1].body).toEqual({ provider: "" });
  });

  it("does not offer to activate a provider that is not ready", async () => {
    await open();
    const p = await screen.findByRole("region", { name: "Anbieter retaindb" });
    expect(within(p).queryByRole("button", { name: "retaindb aktivieren" })).not.toBeInTheDocument();
    expect(within(p).getByText("Key fehlt")).toBeInTheDocument();
  });

  it("deletes only after the name of the file is typed out", async () => {
    await open();
    const b = await screen.findByRole("region", { name: "Eingebautes Gedächtnis" });
    fireEvent.click(within(b).getByRole("button", { name: "MEMORY.md zurücksetzen" }));
    const confirm = within(b).getByLabelText("Zum Bestätigen „memory“ eintippen");
    const go = within(b).getByRole("button", { name: "Endgültig löschen" });
    expect(go).toBeDisabled();
    fireEvent.change(confirm, { target: { value: "user" } });
    expect(go).toBeDisabled();
    fireEvent.change(confirm, { target: { value: "memory" } });
    fireEvent.click(go);
    await within(b).findByText("MEMORY.md: 0 Bytes");
    expect(sent("POST", "/reset")[0].body).toEqual({ target: "memory", confirm: "memory" });
    expect(within(b).getByText("USER.md: 45 Bytes")).toBeInTheDocument();
  });

  it("asks for a fresh login when a change needs one", async () => {
    await open((b) => { b.dash.stepUp = true; b.dash.hm.keySet = true; });
    const p = await screen.findByRole("region", { name: "Anbieter retaindb" });
    fireEvent.click(within(p).getByRole("button", { name: "retaindb aktivieren" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("frische Anmeldung");
  });

  it("says so when the host has no dashboard", async () => {
    await open((b) => { b.dash.hm.available = false; });
    expect(await screen.findByText(/kein Dashboard eingerichtet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /zurücksetzen/ })).not.toBeInTheDocument();
  });
});
