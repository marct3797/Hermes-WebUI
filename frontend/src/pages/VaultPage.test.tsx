import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { installBackend } from "../test-backend";

beforeEach(() => { resetRedirect(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function open(off = false) {
  const backend = installBackend(["gamma"]);
  backend.dash.vault.off = off;
  history.pushState(null, "", "/h/server/hermes/gamma/tresor");
  render(<App />);
  await screen.findByRole("heading", { name: "Tresor und Geheimnisse", level: 1 });
  return backend;
}
const type = (name: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(name), { target: { value } });

describe("Tresor und Geheimnisse", () => {
  it("zeigt Einträge ohne Werte und speichert ein Login, danach ist die Maske leer", async () => {
    const backend = await open();
    expect(await screen.findByText("GitHub")).toBeTruthy();
    type("Name des Eintrags", "Forgejo"); type("Adresse der Seite", "https://git.example.org");
    fireEvent.change(screen.getAllByLabelText("Kennung")[1], { target: { value: "marc" } });
    const save = screen.getByRole("button", { name: "Im Tresor speichern" });
    expect(save).toBeDisabled();
    type("Passwort", "geheim-123");
    expect((screen.getByLabelText("Passwort") as HTMLInputElement).type).toBe("password");
    fireEvent.click(save);
    expect(await screen.findByText("Forgejo")).toBeTruthy();
    expect(backend.dash.vault.added).toHaveLength(1);
    expect((screen.getByLabelText("Passwort") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain("geheim-123");
  });

  it("löscht erst nach dem eingetippten Namen", async () => {
    const backend = await open();
    await screen.findByText("GitHub");
    const del = screen.getByRole("button", { name: "Löschen GitHub" });
    expect(del).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Zum Löschen den Namen eintippen: GitHub"), { target: { value: "GitHub" } });
    fireEvent.click(del);
    await waitFor(() => expect(screen.queryByText("GitHub")).toBeNull());
    expect(backend.dash.vault.items).toHaveLength(0);
  });

  it("zeigt den Status, schaltet erst nach dem Wort aus und ordnet 1Password-Referenzen zu", async () => {
    const backend = await open();
    fireEvent.click(screen.getByRole("button", { name: "Status von Bitwarden prüfen" }));
    expect((await screen.findByLabelText("Ausgabe Bitwarden")).textContent).toContain("Enabled  yes");
    const off = screen.getByRole("button", { name: "Bitwarden ausschalten" });
    expect(off).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Zum Ausschalten „ausschalten“ eintippen: Bitwarden"), { target: { value: "ausschalten" } });
    fireEvent.click(off);
    await waitFor(() => expect(screen.getByLabelText("Ausgabe Bitwarden").textContent).toContain("Enabled  no"));
    expect(backend.dash.vault.enabled.bitwarden).toBe(false);

    type("Variable für 1Password", "openai_api_key");
    type("Referenz für 1Password", "op://Private/OpenAI/api key");
    fireEvent.click(screen.getByRole("button", { name: "Zuordnung speichern" }));
    await waitFor(() => expect(backend.dash.vault.refs).toEqual({ OPENAI_API_KEY: "op://Private/OpenAI/api key" }));
  });

  it("nennt den fehlenden Schalter in hostd", async () => {
    await open(true);
    expect((await screen.findAllByText(/allow_vault/)).length).toBeGreaterThan(0);
  });

  it("verlangt bei Adressen die Pflichtfelder von Hermes, aber keine Seitenadresse", async () => {
    const backend = await open();
    await screen.findByText("GitHub");
    fireEvent.change(screen.getByLabelText("Art"), { target: { value: "address" } });
    type("Name des Eintrags", "Zuhause");
    const save = screen.getByRole("button", { name: "Im Tresor speichern" });
    type("Adresszeile 1 *", "Weg 1"); type("Ort *", "Berlin"); type("Postleitzahl *", "10115");
    expect(save).toBeDisabled();
    type("Land *", "Deutschland");
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    await waitFor(() => expect(backend.dash.vault.added).toHaveLength(1));
  });
});
