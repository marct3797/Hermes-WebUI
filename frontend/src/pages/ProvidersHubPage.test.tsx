import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { page, resetRedirect } from "../api";
import { installBackend } from "../test-backend";

let backend: ReturnType<typeof installBackend>;

async function open(agents = ["gamma", "eta"], prepare?: (b: ReturnType<typeof installBackend>) => void) {
  backend = installBackend(agents);
  prepare?.(backend);
  history.pushState(null, "", "/providers");
  render(<App />);
  await screen.findByRole("heading", { name: "Anbieter", level: 1 });
  const region = await screen.findByRole("region", { name: "Anbieter auf Server" });
  await within(region).findByRole("table");
  return region;
}
const cell = (host: HTMLElement, profile: string, account: string) => within(host).getByRole("button", { name: new RegExp(`^${account} für ${profile}`) });
const writes = (suffix: string, method = "PUT") => backend.calls.filter((c) => c.method === method && c.url.endsWith(suffix));

beforeEach(() => resetRedirect());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Anbieter-Hauptseite", () => {
  it("is a main page in the navigation, next to Gedächtnis", async () => {
    await open();
    const nav = within(screen.getByRole("navigation", { name: "Übersicht" }));
    expect(nav.getByRole("link", { name: "Anbieter" })).toHaveAttribute("href", "/providers");
    expect(nav.getByRole("link", { name: "Anbieter" })).toHaveAttribute("aria-current", "page");
  });

  it("lists every profile of every host with its model and the state of the three accounts", async () => {
    const server = await open();
    const rows = within(server).getAllByRole("row");
    expect(rows).toHaveLength(1 + 2); // Kopf + zwei Profile
    expect(within(server).getByRole("button", { name: "Modell von gamma ändern" })).toHaveTextContent("mock · mock-large");
    expect(cell(server, "gamma", "OpenAI Codex")).toHaveAccessibleName("OpenAI Codex für gamma: angemeldet");
    expect(cell(server, "gamma", "Claude")).toHaveAccessibleName("Claude für gamma: Key hinterlegt");
    expect(cell(server, "eta", "OpenCode Go")).toHaveAccessibleName("OpenCode Go für eta: nicht eingerichtet");
    expect(within(server).getByRole("columnheader", { name: /OpenCode Go/ })).toHaveTextContent("opencode");
    expect(document.body.textContent).not.toContain("geheim");
  });

  it("says plainly that a host is not reachable, without hiding the other hosts", async () => {
    await open();
    const laptop = await screen.findByRole("region", { name: "Anbieter auf Laptop" });
    expect(await within(laptop).findByText(/keine Verbindung zu 100\.64\.3\.4:8642/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Anbieter auf Server" })).toBeInTheDocument();
  });

  it("keeps the profiles visible when the dashboard is down and disables the cells", async () => {
    const server = await open(["gamma"], (b) => { b.dash.available = false; b.dash.reason = "Dashboard antwortet nicht (Verbindung abgelehnt)"; });
    expect(await within(server).findByText(/Das Dashboard von Server antwortet nicht/)).toBeInTheDocument();
    expect(within(server).getByRole("button", { name: "Modell von gamma ändern" })).toBeDisabled();
    expect(cell(server, "gamma", "Claude")).toBeDisabled();
  });

  it("changes provider and model of one profile", async () => {
    const server = await open();
    fireEvent.click(within(server).getByRole("button", { name: "Modell von eta ändern" }));
    const form = await screen.findByRole("form", { name: "Modell von eta" });
    await within(form).findByRole("option", { name: "Anthropic" });
    expect(within(form).getByRole("option", { name: "OpenAI Codex" })).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("Anbieter"), { target: { value: "anthropic" } });
    expect((within(form).getByLabelText("Standardmodell") as HTMLSelectElement).value).toBe("claude-test"); // erstes Modell des neuen Anbieters
    fireEvent.change(within(form).getByLabelText("Standardmodell"), { target: { value: "claude-test-2" } });
    fireEvent.click(within(form).getByRole("button", { name: "Modell speichern" }));
    await screen.findByText(/Modell von eta gespeichert: anthropic · claude-test-2/);
    expect(writes("/eta/profile/model")).toHaveLength(1);
    expect(writes("/eta/profile/model")[0].body).toEqual({ provider: "anthropic", model: "claude-test-2" });
    expect(screen.queryByRole("form", { name: "Modell von eta" })).not.toBeInTheDocument();
    // die Tabelle wurde neu geladen
    await waitFor(() => expect(backend.calls.filter((c) => c.url.endsWith("/_provider-matrix") && c.url.includes("/server/")).length).toBeGreaterThan(1));
  });

  it("warns about a provider without access in that profile", async () => {
    const server = await open(["gamma"], (b) => b.dash.loggedIn.delete("openai-codex"));
    fireEvent.click(within(server).getByRole("button", { name: "Modell von gamma ändern" }));
    const form = await screen.findByRole("form", { name: "Modell von gamma" });
    await within(form).findByRole("option", { name: "OpenAI Codex (nicht angemeldet)" });
    fireEvent.change(within(form).getByLabelText("Anbieter"), { target: { value: "openai-codex" } });
    expect(within(form).getByText(/noch kein Zugang eingerichtet/)).toBeInTheDocument();
  });

  it("logs a profile in to Codex with a device code and waits for the confirmation", async () => {
    const server = await open(["gamma"], (b) => b.dash.loggedIn.delete("openai-codex"));
    expect(cell(server, "gamma", "OpenAI Codex")).toHaveAccessibleName(/nicht eingerichtet/);
    fireEvent.click(cell(server, "gamma", "OpenAI Codex"));
    const panel = await screen.findByRole("region", { name: "OpenAI Codex in gamma" });
    expect(within(panel).getByText(/Nicht eingerichtet/)).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Mit Gerätecode anmelden" }));
    expect(await within(panel).findByLabelText("Gerätecode")).toHaveTextContent("ABCD-1234");
    expect(within(panel).getByRole("link", { name: "https://example.invalid/device" })).toHaveAttribute("rel", "noreferrer noopener");
    await screen.findByText("OpenAI Codex ist angemeldet.", undefined, { timeout: 3000 });
    expect(backend.posted("/gamma/providers/oauth/openai-codex/start")).toHaveLength(1);
    await waitFor(() => expect(cell(server, "gamma", "OpenAI Codex")).toHaveAccessibleName("OpenAI Codex für gamma: angemeldet"));
    expect(screen.queryByRole("region", { name: "OpenAI Codex in gamma" })).not.toBeInTheDocument();
  });

  it("shows why a login failed and lets the person start again", async () => {
    const server = await open(["gamma"], (b) => { b.dash.loggedIn.delete("openai-codex"); b.dash.loginError = "Die Anmeldung wurde abgelehnt."; });
    fireEvent.click(cell(server, "gamma", "OpenAI Codex"));
    const panel = await screen.findByRole("region", { name: "OpenAI Codex in gamma" });
    fireEvent.click(within(panel).getByRole("button", { name: "Mit Gerätecode anmelden" }));
    expect(await within(panel).findByText("Die Anmeldung wurde abgelehnt.", undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Mit Gerätecode anmelden" })).toBeEnabled();
  });

  it("logs a profile in to Claude through the Anthropic page and a pasted code", async () => {
    const server = await open(["gamma"], (b) => { delete b.dash.keys.ANTHROPIC_API_KEY; });
    fireEvent.click(cell(server, "gamma", "Claude"));
    const panel = await screen.findByRole("region", { name: "Claude in gamma" });
    fireEvent.click(within(panel).getByRole("button", { name: "Anmeldung starten" }));
    expect(await within(panel).findByRole("link", { name: "Seite öffnen" })).toHaveAttribute("href", "https://example.invalid/authorize?state=x");
    const input = within(panel).getByLabelText(/Code einfügen/) as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(within(panel).getByRole("button", { name: "Code übergeben" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "gueltig" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Code übergeben" }));
    await screen.findByText("Claude ist angemeldet.");
    expect(backend.posted("/gamma/providers/oauth/anthropic/submit")[0].body).toEqual({ session_id: "sess-pkce-0001", code: "gueltig" });
    await waitFor(() => expect(cell(server, "gamma", "Claude")).toHaveAccessibleName("Claude für gamma: angemeldet"));
    expect(sessionStorage.length + localStorage.length).toBe(0);
  });

  it("reports a rejected Claude code", async () => {
    const server = await open(["gamma"], (b) => { delete b.dash.keys.ANTHROPIC_API_KEY; });
    fireEvent.click(cell(server, "gamma", "Claude"));
    const panel = await screen.findByRole("region", { name: "Claude in gamma" });
    fireEvent.click(within(panel).getByRole("button", { name: "Anmeldung starten" }));
    fireEvent.change(await within(panel).findByLabelText(/Code einfügen/), { target: { value: "falsch" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Code übergeben" }));
    expect(await within(panel).findByRole("alert", undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(cell(server, "gamma", "Claude")).toHaveAccessibleName(/nicht eingerichtet/);
  });

  it("adds an OpenCode Go key to one profile only", async () => {
    const server = await open();
    fireEvent.click(cell(server, "eta", "OpenCode Go"));
    const panel = await screen.findByRole("region", { name: "OpenCode Go in eta" });
    fireEvent.click(await within(panel).findByRole("button", { name: "Key eintragen" }));
    const input = within(panel).getByLabelText("OPENCODE_GO_API_KEY") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: "oc-neu" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Prüfen und speichern" }));
    await screen.findByText("Key für OpenCode Go gespeichert und geprüft.");
    expect(writes("/eta/providers/key")).toHaveLength(1);
    expect(writes("/eta/providers/key")[0].body).toEqual({ var: "OPENCODE_GO_API_KEY", value: "oc-neu" });
    expect(sessionStorage.length + localStorage.length).toBe(0);
  });

  it("asks for a fresh login when the BFF demands one for a login", async () => {
    const assign = vi.spyOn(page, "assign").mockImplementation(() => undefined);
    const server = await open(["gamma"], (b) => { b.dash.loggedIn.delete("openai-codex"); b.dash.stepUp = true; });
    fireEvent.click(cell(server, "gamma", "OpenAI Codex"));
    const panel = await screen.findByRole("region", { name: "OpenAI Codex in gamma" });
    fireEvent.click(within(panel).getByRole("button", { name: "Mit Gerätecode anmelden" }));
    fireEvent.click(await within(panel).findByRole("button", { name: "Erneut anmelden" }));
    expect(assign).toHaveBeenCalledWith(expect.stringContaining("step_up=true"));
  });

  it("lists the coding CLIs per host with their sign-in state", async () => {
    await open();
    const clis = within(screen.getByRole("region", { name: "Coding-CLIs" }));
    const server = await clis.findByRole("group", { name: "Coding-CLIs auf Server" });
    for (const name of ["Claude Code", "OpenCode", "OpenAI Codex"]) expect(await within(server).findByText(name)).toBeInTheDocument();
  });

  it("is reachable from the 'Mehr' sheet on the phone", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Mehr" }));
    expect(within(screen.getByRole("dialog", { name: "Mehr" })).getByRole("link", { name: "Anbieter" })).toHaveAttribute("href", "/providers");
  });
});
