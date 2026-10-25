import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { GUIDE } from "../guide";
import { installBackend } from "../test-backend";

let backend: ReturnType<typeof installBackend>;
const sent = (method: string, suffix: string) => backend.calls.filter((c) => c.method === method && c.url.endsWith(suffix));

async function open(agents = ["gamma"]) {
  backend = installBackend(agents);
  history.pushState(null, "", "/guide");
  render(<App />);
  await screen.findByRole("heading", { name: "Anleitungen", level: 1 });
}
const card = (id: string) => within(screen.getByRole("region", { name: GUIDE.find((e) => e.id === id)!.title }));

beforeEach(() => { resetRedirect(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("GuidePage als Bedienung", () => {
  it("zeigt alle zehn Einträge ohne einen einzigen Befehl", async () => {
    await open();
    expect(GUIDE).toHaveLength(10);
    for (const e of GUIDE) {
      const c = card(e.id);
      const h = c.getByRole("heading");
      expect(h.textContent).toContain(e.title);
    }
    expect(document.body.textContent).not.toMatch(/hermes (whatsapp|setup|tools|computer-use|update|gateway|hooks|config|mcp|hermes-memory)/);
  });

  it("führt jede Karte zur Einstellungsseite", async () => {
    await open();
    // Erst warten, bis der Agent da ist (WhatsApp-Knopf wird dann klickbar).
    await waitFor(() => expect(card("whatsapp").getByRole("button", { name: "Kopplung starten" })).toBeEnabled());
    for (const e of GUIDE) {
      const link = card(e.id).getByRole("link", { name: e.configureLabel });
      expect(link.getAttribute("href")).toMatch(new RegExp(`/h/server/hermes/gamma/${e.configurePath}$`));
    }
  });

  it("koppelt WhatsApp: starten, QR zeigen, übernehmen", async () => {
    await open();
    const c = card("whatsapp");
    const start = c.getByRole("button", { name: "Kopplung starten" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await c.findByText("WA-QR-1");
    await c.findByRole("img", { name: "QR-Code zum Scannen" });
    expect(sent("POST", "/messaging/whatsapp/onboarding")).toHaveLength(1);
    await waitFor(() => expect(c.getByRole("button", { name: "Übernehmen" })).toBeInTheDocument(), { timeout: 8000 });
    fireEvent.click(c.getByRole("button", { name: "Übernehmen" }));
    await waitFor(() => expect(sent("POST", "/messaging/whatsapp/onboarding/wa_pair_1/apply")).toHaveLength(1));
  }, 15000);

  it("stellt das Terminal-Backend um", async () => {
    await open();
    const c = card("terminal");
    fireEvent.click(await c.findByLabelText(/Docker/));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(c.getByRole("button", { name: "Umstellen" }));
    await waitFor(() => expect(sent("PUT", "/terminal-backend")).toHaveLength(1));
    expect(sent("PUT", "/terminal-backend")[0].body).toEqual({ backend: "docker" });
  });

  it("startet post-setup für Werkzeug und Schlüssel", async () => {
    await open();
    const c = card("tools");
    fireEvent.change(await c.findByLabelText("Werkzeug"), { target: { value: "web" } });
    fireEvent.change(c.getByLabelText(/Schlüssel/), { target: { value: "cua_driver" } });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(c.getByRole("button", { name: "Nachinstallieren" }));
    await waitFor(() => expect(sent("POST", "/tools/web/post-setup")).toHaveLength(1));
  });

  it("fordert Computer-Use nur an, wenn Hermes es zulässt", async () => {
    await open();
    const c = card("computeruse");
    expect(c.getByRole("button", { name: "Rechte anfordern" })).toBeDisabled();
    expect(await c.findByText(/keine Rechte aus der Ferne/)).toBeInTheDocument();
  });

  it("startet das Update nur mit eingetipptem Wort", async () => {
    await open();
    const c = card("update");
    await c.findByText("Neu: mock-2");
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("falsch");
    fireEvent.click(c.getByRole("button", { name: "Update starten" }));
    await waitFor(() => expect(c.getByRole("alert")).toBeInTheDocument());
    expect(sent("POST", "/hermes-ops/update")).toHaveLength(0);
    prompt.mockReturnValue("aktualisieren");
    fireEvent.click(c.getByRole("button", { name: "Update starten" }));
    await waitFor(() => expect(sent("POST", "/hermes-ops/update")).toHaveLength(1));
  });

  it("zeigt den Migrationsplan und startet erst mit Wort", async () => {
    await open();
    const c = card("gateway");
    await c.findByText("default");
    vi.spyOn(window, "prompt").mockReturnValue("migrieren");
    fireEvent.click(c.getByRole("button", { name: "Umzug starten" }));
    await waitFor(() => expect(sent("POST", "/gateway/migrate")).toHaveLength(1));
    expect(sent("POST", "/gateway/migrate")[0].body).toEqual({ confirm: "migrieren" });
  });

  it("legt Hooks mit Bestätigung an und löscht sie wieder", async () => {
    await open();
    const c = card("hooks");
    await c.findByText("before_tool");
    fireEvent.change(c.getByLabelText("Ereignis"), { target: { value: "after_tool" } });
    fireEvent.change(c.getByLabelText("Befehl"), { target: { value: "echo fertig" } });
    vi.spyOn(window, "prompt").mockReturnValue("echo fertig");
    fireEvent.click(c.getByRole("button", { name: "Hook anlegen" }));
    await waitFor(() => expect(sent("POST", "/hermes-hooks")).toHaveLength(1));
    const inputs = c.getAllByLabelText(/Befehl zur Bestätigung/);
    fireEvent.change(inputs[0], { target: { value: "echo hi" } });
    fireEvent.click(c.getAllByRole("button", { name: "Löschen" })[0]);
    await waitFor(() => expect(sent("DELETE", "/hermes-hooks")).toHaveLength(1));
    expect(sent("DELETE", "/hermes-hooks")[0].body).toEqual({ event: "before_tool", command: "echo hi", confirm: "echo hi" });
  });

  it("löscht Env-Schlüssel erst nach Wortabgleich", async () => {
    await open();
    const c = card("env");
    fireEvent.change(c.getByLabelText("Schlüsselname"), { target: { value: "ANTHROPIC_API_KEY" } });
    vi.spyOn(window, "prompt").mockReturnValue("ANTHROPIC_API_KEY");
    fireEvent.click(c.getByRole("button", { name: "Löschen" }));
    await waitFor(() => expect(sent("DELETE", "/env/ANTHROPIC_API_KEY")).toHaveLength(1));
  });

  it("ersetzt die MCP-Liste nur mit gültigem JSON und Wort", async () => {
    await open();
    const c = card("mcp");
    fireEvent.change(c.getByLabelText(/Ganze Liste/), { target: { value: "kein json" } });
    vi.spyOn(window, "prompt").mockReturnValue("ERSETZEN");
    fireEvent.click(c.getByRole("button", { name: "Liste ersetzen" }));
    await waitFor(() => expect(c.getByRole("alert")).toBeInTheDocument());
    expect(backend.calls.some((x) => x.method === "PUT" && x.url.endsWith("/mcp"))).toBe(false);
  });

  it("aktiviert Speicher-Anbieter und startet Setup", async () => {
    await open();
    const c = card("memory");
    fireEvent.change(await c.findByLabelText("Anbieter"), { target: { value: "retaindb" } });
    fireEvent.click(c.getByRole("button", { name: "Aktivieren" }));
    await waitFor(() => expect(sent("PUT", "/hermes-memory/provider")).toHaveLength(1));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(c.getByRole("button", { name: "Programm installieren" }));
    await waitFor(() => expect(sent("POST", "/hermes-memory/providers/retaindb/setup")).toHaveLength(1));
  });
});
