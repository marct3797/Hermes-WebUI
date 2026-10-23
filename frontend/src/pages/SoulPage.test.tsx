import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { page, resetRedirect } from "../api";
import { installBackend } from "../test-backend";

let backend: ReturnType<typeof installBackend>;
const OLD = "Du bist Raiden.\nDu antwortest knapp.\n";

async function open() {
  backend = installBackend(["raiden"]);
  history.pushState(null, "", "/h/hikari/hermes/raiden/soul");
  render(<App />);
  await screen.findByRole("heading", { name: "SOUL & Profil", level: 1 });
  return (await screen.findByLabelText("Inhalt von SOUL.md")) as HTMLTextAreaElement;
}
const writes = () => backend.calls.filter((c) => c.method === "PUT" && c.url.endsWith("/soul"));
const type = (ta: HTMLElement, value: string) => fireEvent.change(ta, { target: { value } });
const save = () => screen.getByRole("button", { name: "Speichern" });

beforeEach(() => { resetRedirect(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("SOUL & Profil", () => {
  it("loads the text, previews the change and saves it with the loaded fingerprint", async () => {
    const ta = await open();
    expect(ta.value).toBe(OLD);
    expect(screen.getByText(`${OLD.length} / 100 Zeichen`)).toBeInTheDocument();
    expect(save()).toBeDisabled();
    type(ta, "Du bist Raiden.\nDu antwortest ausführlich.\n");
    fireEvent.click(screen.getByRole("button", { name: "Änderungen ansehen" }));
    const diff = screen.getByRole("region", { name: "Änderungen gegenüber dem gespeicherten Stand" });
    expect(within(diff).getByText("Du antwortest knapp.")).toBeInTheDocument();
    expect(within(diff).getByText("Du antwortest ausführlich.")).toBeInTheDocument();
    expect(within(diff).getByText("+1")).toBeInTheDocument();
    fireEvent.click(save());
    await screen.findByText(/Gespeichert\. Der bisherige Text liegt im Verlauf/);
    expect(writes()).toHaveLength(1);
    expect(writes()[0].body).toEqual({ content: "Du bist Raiden.\nDu antwortest ausführlich.\n", base: `h${OLD.length}:Du bist Raid` });
    expect(save()).toBeDisabled();
    expect(within(screen.getByRole("region", { name: "Verlauf" })).getByText(`vor Änderung · ${OLD.length} Zeichen`)).toBeInTheDocument();
  });

  it("discards edits and refuses a text above the limit", async () => {
    const ta = await open();
    type(ta, "x".repeat(101));
    expect(screen.getByText(/101 \/ 100 Zeichen/)).toHaveClass("error");
    expect(save()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Verwerfen" }));
    expect(ta.value).toBe(OLD);
    expect(writes()).toHaveLength(0);
  });

  it("offers a choice when the file changed in the meantime, and keeps what it overwrites", async () => {
    const ta = await open();
    backend.dash.soul = "Der Agent hat sich selbst umgeschrieben.\n";
    type(ta, "Meine Fassung\n");
    fireEvent.click(save());
    const banner = await screen.findByText("SOUL.md wurde inzwischen geändert");
    expect(banner).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: /Unterschied zwischen dem neuen Stand/ })).getByText("Meine Fassung")).toBeInTheDocument();
    expect(backend.dash.soul).toBe("Der Agent hat sich selbst umgeschrieben.\n");
    fireEvent.click(screen.getByRole("button", { name: "Trotzdem mit meinem Text überschreiben" }));
    await screen.findByText(/Gespeichert/);
    expect(backend.dash.soul).toBe("Meine Fassung\n");
    expect(backend.dash.versions[backend.dash.history[0].id]).toBe("Der Agent hat sich selbst umgeschrieben.\n");
    expect(screen.queryByText("SOUL.md wurde inzwischen geändert")).not.toBeInTheDocument();
  });

  it("can take over the newer text and drop the draft", async () => {
    const ta = await open();
    backend.dash.soul = "Neuer Stand\n";
    type(ta, "Mein Entwurf\n");
    fireEvent.click(save());
    fireEvent.click(await screen.findByRole("button", { name: "Neuen Stand laden, Entwurf verwerfen" }));
    expect(ta.value).toBe("Neuer Stand\n");
    expect(save()).toBeDisabled();
    expect(writes()).toHaveLength(1); // nur der abgelehnte Versuch
  });

  it("asks for a fresh login, keeps the draft over the redirect and restores it afterwards", async () => {
    const ta = await open();
    backend.dash.stepUp = true;
    type(ta, "Wichtiger Entwurf\n");
    fireEvent.click(save());
    await screen.findByText(/verlangt eine frische Anmeldung/);
    const assign = vi.spyOn(page, "assign").mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Erneut anmelden" }));
    expect(assign).toHaveBeenCalledWith(expect.stringContaining("step_up=true"));
    cleanup(); // die Seite lädt nach der Anmeldung neu
    resetRedirect();
    backend.dash.stepUp = false;
    render(<App />);
    const again = (await screen.findByLabelText("Inhalt von SOUL.md")) as HTMLTextAreaElement;
    await waitFor(() => expect(again.value).toBe("Wichtiger Entwurf\n"));
    expect(screen.getByText(/Dein Entwurf aus der Anmeldung ist wieder da/)).toBeInTheDocument();
    fireEvent.click(save());
    await screen.findByText(/Gespeichert/);
    expect(backend.dash.soul).toBe("Wichtiger Entwurf\n");
    expect(sessionStorage.length).toBe(0);
  });

  it("shows a version against the current text and restores it, keeping the current text in the history", async () => {
    const ta = await open();
    type(ta, "Zweite Fassung\n");
    fireEvent.click(save());
    await screen.findByText(/Gespeichert/);
    const hist = within(screen.getByRole("region", { name: "Verlauf" }));
    fireEvent.click(hist.getByRole("button", { name: "Ansehen" }));
    const diff = await screen.findByRole("region", { name: /Unterschied zwischen .* und jetzt/ });
    expect(within(diff).getByText("Du antwortest knapp.")).toBeInTheDocument();
    type(ta, "Ungespeichert\n");
    expect(hist.getByRole("button", { name: "Diese Fassung wiederherstellen" })).toBeDisabled(); // sonst gingen die Änderungen verloren
    fireEvent.click(screen.getByRole("button", { name: "Verwerfen" }));
    fireEvent.click(hist.getByRole("button", { name: "Diese Fassung wiederherstellen" }));
    await screen.findByText(/Wiederhergestellt/);
    expect(ta.value).toBe(OLD);
    expect(backend.dash.soul).toBe(OLD);
    expect(hist.getAllByRole("button", { name: "Ansehen" })).toHaveLength(2);
    expect(hist.getByText(/vor Wiederherstellung/)).toBeInTheDocument();
  });

  it("explains how to connect the dashboard when there is none", async () => {
    backend = installBackend(["raiden"]);
    backend.dash.available = false;
    backend.dash.reason = "Für diese Runtime ist kein Dashboard eingerichtet";
    history.pushState(null, "", "/h/hikari/hermes/raiden/soul");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Dashboard nicht angebunden" })).toBeInTheDocument();
    expect(screen.getByText("Für diese Runtime ist kein Dashboard eingerichtet")).toBeInTheDocument();
    expect(screen.getByText(/"dashboard": \{ "base_url"/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Inhalt von SOUL.md")).not.toBeInTheDocument();
  });

  it("saves the description and the default model of the profile", async () => {
    await open();
    const desc = screen.getByLabelText("Beschreibung");
    fireEvent.change(desc, { target: { value: "  Wacht über Deployments  " } });
    fireEvent.click(screen.getByRole("button", { name: "Beschreibung speichern" }));
    await screen.findByText("Beschreibung gespeichert.");
    expect(backend.dash.description).toBe("Wacht über Deployments");
    expect(screen.getByRole("button", { name: "Beschreibung speichern" })).toBeDisabled();

    expect(screen.getByRole("button", { name: "Modell speichern" })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("option", { name: "mock-small" })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Standardmodell"), { target: { value: "mock-small" } });
    fireEvent.click(screen.getByRole("button", { name: "Modell speichern" }));
    await screen.findByText("Modell gespeichert.");
    expect(backend.dash.model).toEqual({ provider: "mock", model: "mock-small" });
  });

  it("is reachable from the chat's session column and the host overview", async () => {
    backend = installBackend(["raiden"]);
    history.pushState(null, "", "/h/hikari/hermes/raiden");
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "SOUL von raiden" }));
    await screen.findByRole("heading", { name: "SOUL & Profil", level: 1 });
  });
});
