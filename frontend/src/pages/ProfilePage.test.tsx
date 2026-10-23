import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { installBackend } from "../test-backend";
import type { UiConfig } from "../types";

let calls: ReturnType<typeof installBackend>["calls"];

async function open(ui: Partial<UiConfig> = { writable: true, write_error: null }, heading = "raiden") {
  ({ calls } = installBackend(["raiden"], undefined, ui));
  history.pushState(null, "", "/h/hikari/hermes/raiden/profil");
  render(<App />);
  await screen.findByRole("heading", { name: heading, level: 1 });
}
/** Ohne gespeichertes Sigil beginnt der Editor bei den Initialen, wie die Kachel sie zeigt; die Symbole liegen im ersten Reiter. */
const symbols = () => fireEvent.click(screen.getByRole("tab", { name: "Symbol" }));
const saves = () => calls.filter((c) => c.method === "PUT");
const save = () => screen.getByRole("button", { name: "Speichern" });
const snippet = () => screen.getByRole("region", { name: "Eintrag" }).textContent ?? "";

beforeEach(() => resetRedirect());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Profil bearbeiten", () => {
  it("saves symbol, colour and display name in the WebUI config and shows the name everywhere", async () => {
    await open();
    expect(save()).toBeDisabled(); // nichts geändert
    symbols();
    fireEvent.click(screen.getByRole("button", { name: "terminal" }));
    fireEvent.click(screen.getByRole("button", { name: "Farbton 98°" }));
    fireEvent.change(screen.getByLabelText("Anzeigename"), { target: { value: "Raiden" } });
    expect(snippet()).toContain('"label": "Raiden"');
    expect(snippet()).toContain('"glyph": "neutral/terminal"');
    fireEvent.click(save());
    await screen.findByText("Gespeichert");
    expect(saves()).toHaveLength(1);
    expect(saves()[0].url).toBe("/bff/ui/profiles/hikari/hermes/raiden");
    expect(saves()[0].body).toEqual({ label: "Raiden", sigil: { type: "glyph", glyph: "neutral/terminal", hue: 98 } });
    // Der neue Name gilt in der ganzen WebUI, ohne Neuladen.
    expect(screen.getByRole("heading", { name: "Raiden", level: 1 })).toBeInTheDocument();
    expect(within(screen.getByRole("complementary", { name: "Navigation" })).getByRole("link", { name: /^Raiden/ })).toBeInTheDocument();
    expect(save()).toBeDisabled();
  });

  it("builds the config entry live while editing initials and a neutral colour", async () => {
    await open();
    fireEvent.click(screen.getByRole("tab", { name: "Initialen" }));
    fireEvent.change(screen.getByLabelText(/^Initialen/), { target: { value: "RZ" } });
    fireEvent.click(screen.getByRole("button", { name: "Neutral (grau)" }));
    expect(snippet()).toContain('"type": "initials"');
    expect(snippet()).toContain('"text": "RZ"');
    expect(snippet()).toContain('"hue": null');
    fireEvent.click(save());
    await screen.findByText("Gespeichert");
    expect(saves()[0].body).toEqual({ label: null, sigil: { type: "initials", text: "RZ", hue: null } });
  });

  it("sets the hue from the slider and shows what automatic resolves to", async () => {
    await open();
    expect(screen.getByText(/Feinjustierung · \d+° \(automatisch\)/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Farbton fein einstellen"), { target: { value: "200" } });
    expect(screen.getByText("Feinjustierung · 200°")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Automatisch aus dem Namen" })).toHaveAttribute("aria-pressed", "false");
  });

  it("leaves out a name that equals the profile folder", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Anzeigename"), { target: { value: " raiden " } });
    symbols();
    fireEvent.click(screen.getByRole("button", { name: "bolt" }));
    fireEvent.click(save());
    await screen.findByText("Gespeichert");
    expect(saves()[0].body).toMatchObject({ label: null });
  });

  it("explains a read-only config, disables saving and still offers the entry to copy", async () => {
    await open({ writable: false });
    symbols();
    fireEvent.click(screen.getByRole("button", { name: "terminal" }));
    expect(save()).toBeDisabled();
    expect(save()).toHaveAttribute("title", "Die ui.json ist für die WebUI schreibgeschützt.");
    expect(screen.getByRole("status")).toHaveTextContent("schreibgeschützt");
    expect(screen.getByText("Eintrag für die ui.json")).toBeInTheDocument();
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: write } });
    fireEvent.click(screen.getByRole("button", { name: /Kopieren/ }));
    await waitFor(() => expect(write).toHaveBeenCalled());
    expect(write.mock.calls[0][0]).toContain('"hikari/hermes/raiden"');
    expect(saves()).toHaveLength(0);
  });

  it("shows the server's reason when saving fails and keeps the changes", async () => {
    await open({ writable: true, write_error: null });
    symbols();
    fireEvent.click(screen.getByRole("button", { name: "terminal" }));
    vi.mocked(fetch).mockImplementationOnce(async () => new Response(JSON.stringify({ detail: "SVG abgelehnt: Element nicht erlaubt: script" }), { status: 422 }));
    fireEvent.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent("SVG abgelehnt");
    expect(save()).toBeEnabled();
  });

  it("offers packs from the config and saves a symbol of that pack", async () => {
    await open({ writable: true, write_error: null, packs: { japan: ["kaze", "raiden"] } });
    expect(screen.getByRole("button", { name: /^Neutral STANDARD/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /^Japan/ }));
    expect(screen.getAllByRole("button", { name: /^(kaze|raiden)$/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "raiden" }));
    fireEvent.click(save());
    await screen.findByText("Gespeichert");
    expect(saves()[0].body).toMatchObject({ sigil: { type: "glyph", glyph: "japan/raiden" } });
  });

  it("hides the pack choice when there is only the neutral pack", async () => {
    await open();
    expect(screen.queryByText("Symbol-Pack")).toBeNull();
  });

  it("takes a custom SVG after a check in the browser and sends its text for cleaning", async () => {
    await open();
    fireEvent.click(screen.getByRole("tab", { name: "Eigenes SVG" }));
    expect(screen.getByText(/Ohne Datei lässt sich dieses Sigil nicht speichern/)).toBeInTheDocument();
    const input = screen.getByLabelText("SVG-Datei wählen");
    const pick = (text: string, name = "mein.svg") => fireEvent.change(input, { target: { files: [new File([text], name, { type: "image/svg+xml" })] } });

    pick("das ist kein svg", "x.svg");
    expect(await screen.findByText("Das ist kein gültiges SVG.")).toBeInTheDocument();
    pick('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>');
    expect(await screen.findByText("Dem SVG fehlt das viewBox-Attribut.")).toBeInTheDocument();
    pick(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${"M0 0".repeat(6000)}"/></svg>`);
    expect(await screen.findByText("Die Datei ist größer als 20 KB.")).toBeInTheDocument();
    expect(save()).toBeDisabled();

    const good = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M13 3 5.500 13.500H11L10 21l8-11h-5.500z"/></svg>';
    pick(good);
    expect(await screen.findByText(/gewählt/)).toHaveTextContent("mein.svg");
    expect(screen.queryByText("Das ist kein gültiges SVG.")).toBeNull();
    // Die Vorschau zeigt die Datei als Maske, bevor sie gespeichert ist.
    const masks = [...document.querySelectorAll<HTMLElement>(".pf-sizes .sg")].map((e) => e.style.getPropertyValue("--g"));
    expect(masks).toHaveLength(5);
    expect(masks.every((m) => m.startsWith('url("data:image/svg+xml;base64,'))).toBe(true);
    fireEvent.click(save());
    await screen.findByText("Gespeichert");
    expect(saves()[0].body).toEqual({ label: null, sigil: { type: "svg", hue: "auto", svg: good } });
    // Danach liegt das Symbol auf dem Server: Farbton ändern, ohne die Datei erneut zu senden.
    fireEvent.click(screen.getByRole("button", { name: "Farbton 180°" }));
    fireEvent.click(save());
    await waitFor(() => expect(saves()).toHaveLength(2));
    expect(saves()[1].body).toEqual({ label: null, sigil: { type: "svg", hue: 180 } });
  });

  it("resets a saved profile to the default", async () => {
    await open({
      writable: true, write_error: null,
      sigils: { "hikari/hermes/raiden": { type: "glyph", glyph: "neutral/bolt", hue: 98 } }, labels: { "hikari/hermes/raiden": "Blitz" },
    }, "Blitz");
    fireEvent.click(screen.getByRole("button", { name: "Auf Standard zurücksetzen" }));
    await screen.findByText("Auf Standard zurückgesetzt");
    expect(saves()[0].body).toEqual({ label: null, sigil: null });
    expect(screen.getByRole("heading", { name: "raiden", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Auf Standard zurücksetzen" })).toBeNull();
  });

  it("says when the sigil comes from the general entry of the profile name", async () => {
    await open({ writable: true, write_error: null, sigils: { raiden: { type: "glyph", glyph: "neutral/bolt", hue: 98 } } });
    expect(screen.getByText(/Aktuell gilt der allgemeine Eintrag „raiden“/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "bolt" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "Auf Standard zurücksetzen" })).toBeNull();
  });

  it("is reachable from the session column and goes back to the chat", async () => {
    installBackend(["raiden"]);
    history.pushState(null, "", "/h/hikari/hermes/raiden/chat");
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Profil von raiden bearbeiten" }));
    await screen.findByRole("heading", { name: "raiden", level: 1 });
    expect(location.pathname).toBe("/h/hikari/hermes/raiden/profil");
    fireEvent.click(screen.getByRole("link", { name: "Zurück zu raiden" }));
    await screen.findByPlaceholderText("Nachricht an raiden…");
  });
});
