import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { page, resetRedirect } from "../api";
import { installBackend } from "../test-backend";

let backend: ReturnType<typeof installBackend>;

async function open() {
  backend = installBackend(["raiden"]);
  history.pushState(null, "", "/h/hikari/hermes/raiden/providers");
  render(<App />);
  await screen.findByRole("heading", { name: "Keys & Nutzung", level: 1 });
  await screen.findByRole("region", { name: "Eingerichtete Anbieter" });
}
const active = () => within(screen.getByRole("region", { name: "Eingerichtete Anbieter" }));
const writes = () => backend.calls.filter((c) => c.method === "PUT" && c.url.endsWith("/providers/key"));
const paste = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => resetRedirect());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Anbieter", () => {
  it("shows configured providers with usage and masked keys, and hides the rest", async () => {
    await open();
    expect(screen.getByText("raiden · 2 eingerichtet")).toBeInTheDocument();
    const anthropic = within(active().getByText("Anthropic").closest("li")!);
    expect(anthropic.getByText((_, el) => el?.tagName === "P" && (el.textContent ?? "").startsWith("12 Sessions · 1,5 M Token · 4,50 $ in 30 T"))).toBeInTheDocument();
    expect(anthropic.getByText("gesetzt")).toBeInTheDocument(); expect(anthropic.queryByText(/sk-a/)).toBeNull(); // nie Key-Fragmente
    expect(anthropic.getByText("claude-test")).toBeInTheDocument(); // Modelle ohne Wiederholung
    const codex = within(active().getByText("OpenAI Codex").closest("li")!);
    expect(codex.getByText(/Angemeldet über ~\/\.codex\/auth\.json/)).toBeInTheDocument();
    expect(screen.queryByText("OpenRouter")).not.toBeInTheDocument(); // nicht eingerichtet: erst auf Wunsch
    expect(document.body.textContent).not.toContain("geheim");
  });

  it("mentions the terminal login only for providers without a key", async () => {
    await open();
    expect(within(active().getByText("Anthropic").closest("li")!).queryByText(/Nicht angemeldet/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Anbieter hinzufügen/ }));
    const gemini = within(screen.getByText("Google Gemini").closest("li")!);
    expect(gemini.getByText(/Nicht angemeldet\./)).toBeInTheDocument();
    expect(gemini.getByText("hermes auth add gemini")).toBeInTheDocument();
  });

  it("reloads with another period", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "7 Tage" }));
    await screen.findByText(/in 7 T/);
    expect(backend.calls.some((c) => c.url.endsWith("/providers?days=7"))).toBe(true);
  });

  it("adds a provider: checks the key, saves it and moves the provider up", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: /Anbieter hinzufügen \(3 verfügbar\)/ }));
    const card = within(screen.getByText("OpenRouter").closest("li")!);
    fireEvent.click(card.getByRole("button", { name: "Key eintragen" }));
    paste("OPENROUTER_API_KEY", "  sk-or-neu  ");
    expect((screen.getByLabelText("OPENROUTER_API_KEY") as HTMLInputElement).type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Prüfen und speichern" }));
    await screen.findByText("Key für OpenRouter gespeichert und geprüft.");
    expect(writes()).toHaveLength(1);
    expect(writes()[0].body).toEqual({ var: "OPENROUTER_API_KEY", value: "sk-or-neu" });
    await waitFor(() => expect(active().getByText("OpenRouter")).toBeInTheDocument());
    expect(sessionStorage.length + localStorage.length).toBe(0); // der Key landet nirgends im Browser
  });

  it("does not save a key the provider rejects", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Key ersetzen" }));
    paste(/Neuen Key|ANTHROPIC/, "bad");
    fireEvent.click(screen.getByRole("button", { name: "Prüfen und speichern" }));
    expect(await screen.findByText("Der Anbieter hat den Key abgelehnt.")).toBeInTheDocument();
    expect(writes()).toHaveLength(0);
  });

  it("saves anyway when the provider cannot be reached for the check, and says so", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Key ersetzen" }));
    paste(/ANTHROPIC/, "offline");
    fireEvent.click(screen.getByRole("button", { name: "Prüfen und speichern" }));
    await screen.findByText(/ließ sich nicht zur Prüfung erreichen/);
    expect(writes()).toHaveLength(1);
  });

  it("asks for a fresh login before saving", async () => {
    await open();
    backend.dash.stepUp = true;
    fireEvent.click(screen.getByRole("button", { name: "Key ersetzen" }));
    paste(/ANTHROPIC/, "sk-neu");
    fireEvent.click(screen.getByRole("button", { name: "Prüfen und speichern" }));
    await screen.findByText(/verlangt eine frische Anmeldung/);
    const assign = vi.spyOn(page, "assign").mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Erneut anmelden" }));
    expect(assign).toHaveBeenCalledWith(expect.stringContaining("step_up=true"));
    expect(backend.dash.keys.ANTHROPIC_API_KEY).toBe("sk-ant-geheim-1234"); // nichts überschrieben
  });

  it("is reachable from the session column and leads to the hub for providers per host", async () => {
    backend = installBackend(["raiden"]);
    history.pushState(null, "", "/h/hikari/hermes/raiden");
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Keys von raiden" }));
    await screen.findByRole("heading", { name: "Keys & Nutzung", level: 1 });
  });
});
