import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { installBackend } from "../test-backend";

let backend: ReturnType<typeof installBackend>;
async function open() {
  backend = installBackend(["gamma", "delta"]);
  history.pushState(null, "", "/assistant");
  render(<App />);
  await screen.findByRole("heading", { name: "Einrichtungsassistent", level: 1 });
}
const sent = (method: string, part: string) => backend.calls.filter((c) => c.method === method && c.url.includes(part));
const step = async (n: number) => {
  const secs = await screen.findAllByLabelText(`Schritt ${n}`, { exact: false });
  return secs.find((x) => x.getAttribute("aria-label") === `Schritt ${n}`) ?? secs[0];
};

beforeEach(() => { resetRedirect(); sessionStorage.clear(); });
afterEach(() => { cleanup(); });

describe("Einrichtungsassistent", () => {
  it("Kopf zeigt Fortschritt als Balken mit n von 5", async () => {
    await open();
    backend.dash.mdFresh = true;
    backend.dash.sessEmpty = true;
    fireEvent.click((await step(1)).querySelector("button") as HTMLElement);
    await waitFor(() => expect(screen.getByText("2 von 5 erledigt")).toBeInTheDocument());
    const bar = await screen.findByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("2");
    expect(bar.getAttribute("aria-valuemax")).toBe("5");
  });

  it("zeigt Schritt 1 mit Host-Label, Agent-Pfad und Zustand", async () => {
    await open();
    fireEvent.click((await step(1)).querySelector("button") as HTMLElement);
    const s1 = await step(1);
    await waitFor(() => expect(s1.textContent).toContain("Erledigt"));
    expect(s1.textContent).toMatch(/Server/);
    expect(s1.textContent).toMatch(/server\/hermes\/gamma|Server \/ Hermes \/ gamma/);
    expect(s1.textContent).toMatch(/Version 0\.21\.6|0\.21\.6/);
  });

  it("Schritt 2 listet alle warnenden Checks, nicht nur den ersten", async () => {
    await open();
    backend.dash.diagWarn = ["Erreichbar und angemeldet: Version 0.21.6", "Modelle und Anbieter: 1 Anbieter, 2 Modelle"];
    fireEvent.click((await step(1)).querySelector("button") as HTMLElement);
    const s2 = await step(2);
    await waitFor(() => expect(s2.textContent).toContain("Offen"));
    expect(s2.textContent).toMatch(/Erreichbar und angemeldet/);
    expect(s2.textContent).toMatch(/Modelle und Anbieter/);
    backend.dash.diagWarn = undefined;
  });

  it("Schritt 3 nennt Anbieter-Namen und Zahl konfiguriert/gesamt", async () => {
    await open();
    backend.dash.mdFresh = false;
    fireEvent.click((await step(1)).querySelector("button") as HTMLElement);
    const s3 = await step(3);
    await waitFor(() => expect(s3.textContent).toContain("Erledigt"));
    expect(s3.textContent).toMatch(/2 von \d+ eingerichtet|konfiguriert/i);
  });

  it("Schritt 4 nennt Anbieter- und Modellnamen", async () => {
    await open();
    fireEvent.click((await step(1)).querySelector("button") as HTMLElement);
    const s4 = await step(4);
    await waitFor(() => expect(s4.textContent).toContain("Erledigt"));
    expect(s4.textContent).toMatch(/anthropic/i);
    expect(s4.textContent).toMatch(/claude-test/);
  });

  it("Schritt 5 nennt die Sitzungszahl", async () => {
    await open();
    fireEvent.click((await step(1)).querySelector("button") as HTMLElement);
    const s5 = await step(5);
    await waitFor(() => expect(s5.textContent).toContain("Erledigt"));
    expect(s5.textContent).toMatch(/1 Sitzung|1 Sitzungen/i);
  });

  it("Schritte sind nummerierte Karten mit Zustandszeichen, Details aufklappbar", async () => {
    await open();
    backend.dash.mdFresh = true;
    backend.dash.sessEmpty = true;
    fireEvent.click((await step(1)).querySelector("button") as HTMLElement);
    await waitFor(() => expect(screen.getByText("2 von 5 erledigt")).toBeInTheDocument());
    const s1 = await step(1);
    expect(s1.textContent).toMatch(/●|✓|○|◌|!/);
    expect(s1.querySelector("details")).not.toBeNull();
  });

  it("Fehlerkarte nennt die konkrete Abhilfe mit Link", async () => {
    await open();
    backend.dash.provDown = true;
    fireEvent.click((await step(1)).querySelector("button") as HTMLElement);
    const s3 = await step(3);
    await waitFor(() => expect(s3.textContent).toContain("Fehler"));
    const link = s3.querySelector("a");
    expect(link).not.toBeNull();
    backend.dash.provDown = false;
  });

  it("zeigt fünf datengetriebene Schritte und 2 von 5 auf frischer Installation", async () => {
    await open();
    backend.dash.mdFresh = true; // noch kein Anbieter, kein Modell
    backend.dash.sessEmpty = true; // noch keine Sitzung
    fireEvent.click((await step(1)).querySelector("button") as HTMLElement);
    await waitFor(() => expect(screen.getByText("2 von 5 erledigt")).toBeInTheDocument());
    expect(await screen.findAllByLabelText("Schritt 1", { exact: false })).not.toHaveLength(0);
    const s1 = await step(1);
    expect(s1.textContent).toContain("Erledigt");
    const s3 = await step(3);
    expect(s3.textContent).toContain("Offen");
    const s4 = await step(4);
    expect(s4.textContent).toContain("Wartet");
    expect((await step(5)).textContent).not.toMatch(/Fehler/);
  });

  it("Schritt 1 offen ohne Host, mit Hinweis auf das Terminal-Skript", async () => {
    await open();
    backend.dash.hostsEmpty = true;
    fireEvent.click((await step(1)).querySelector("button") as HTMLElement);
    const s1 = await step(1);
    await waitFor(() => expect(s1.textContent).toContain("Offen"));
    expect(s1.textContent).toMatch(/deploy\/setup\.py/);
    expect(s1.textContent).toMatch(/deploy\/add-host\.sh/);
  });

  it("Schritt 1 Fehler mit Grund, wenn der Agent nicht antwortet", async () => {
    await open();
    backend.dash.statusDown = true;
    fireEvent.click((await step(1)).querySelector("button") as HTMLElement);
    const s1 = await step(1);
    await waitFor(() => expect(s1.textContent).toContain("Fehler"));
    expect(s1.textContent).toMatch(/antwortet nicht/);
    backend.dash.statusDown = false;
  });

  it("Schritt 2 Fehler mit Grund, wenn die Diagnose scheitert", async () => {
    await open();
    backend.dash.diagDown = true;
    fireEvent.click((await step(1)).querySelector("button") as HTMLElement);
    const s2 = await step(2);
    await waitFor(() => expect(s2.textContent).toContain("Fehler"));
    expect(s2.textContent).toMatch(/Diagnose nicht lesbar/);
    backend.dash.diagDown = false;
  });

  it("Schritt 3 Fehler mit Grund, wenn Anbieter nicht lesbar", async () => {
    await open();
    backend.dash.provDown = true;
    fireEvent.click((await step(1)).querySelector("button") as HTMLElement);
    const s3 = await step(3);
    await waitFor(() => expect(s3.textContent).toContain("Fehler"));
    expect(s3.textContent).toMatch(/Anbieterliste nicht lesbar/);
    backend.dash.provDown = false;
  });

  it("Schritt 4 wartet auf Schritt 3 und zeigt den Fehler der Modell-Info", async () => {
    await open();
    backend.dash.mdFresh = true; // Schritt 3 offen
    fireEvent.click((await step(1)).querySelector("button") as HTMLElement);
    const s4 = await step(4);
    await waitFor(() => expect(s4.textContent).toContain("Wartet"));
    backend.dash.mdFresh = false;
    backend.dash.mdDown = true; // Modell-Info kaputt, aber Anbieter eingerichtet
    fireEvent.click((await step(1)).querySelector("button") as HTMLElement);
    await waitFor(() => expect(s4.textContent).toContain("Fehler"));
    expect(s4.textContent).toMatch(/unbekannter Form/);
    backend.dash.mdDown = false;
  });

  it("Schritt 5 Fehler mit Grund bei kaputten Sitzungen", async () => {
    await open();
    backend.dash.sessDown = true;
    fireEvent.click((await step(1)).querySelector("button") as HTMLElement);
    const s5 = await step(5);
    await waitFor(() => expect(s5.textContent).toContain("Fehler"));
    expect(s5.textContent).toMatch(/Sitzungen nicht lesbar/);
    backend.dash.sessDown = false;
  });

  it("Mehrere Hosts: Auswahl wirkt (anderer Host wird geprüft)", async () => {
    await open();
    const sel = await screen.findByLabelText("Host wählen") as HTMLSelectElement;
    expect(sel.options.length).toBe(2);
    backend.dash.altDown = true; // zweiter Host (laptop) meldet Fehler
    fireEvent.change(sel, { target: { value: "laptop" } });
    const s1 = await step(1);
    await waitFor(() => expect(s1.textContent).toContain("Fehler"));
    backend.dash.altDown = false;
  });

  it("Erneut prüfen holt neu: Status wechselt nach Mock-Änderung", async () => {
    await open();
    backend.dash.sessEmpty = true;
    fireEvent.click((await step(1)).querySelector("button") as HTMLElement);
    const s5 = await step(5);
    await waitFor(() => expect(s5.textContent).toContain("Offen"));
    backend.dash.sessEmpty = false;
    fireEvent.click((await step(1)).querySelector("button") as HTMLElement);
    await waitFor(() => expect(s5.textContent).toContain("Erledigt"));
  });

  it("sendet nie POST, PUT oder DELETE", async () => {
    await open();
    fireEvent.click((await step(3)).querySelector("button") as HTMLElement);
    const s3 = await step(3);
    await waitFor(() => expect(s3.textContent).toMatch(/Erledigt|Offen|Fehler|Wartet/));
    const writes = backend.calls.filter((c) => c.method === "POST" || c.method === "PUT" || c.method === "DELETE");
    expect(writes).toHaveLength(0);
    expect(sent("GET", "/bff/hosts").length).toBeGreaterThan(0);
  });

  it("Schritte sind sections mit Status als Text, Fokus sichtbar", async () => {
    await open();
    const s2 = await step(2);
    expect(s2.tagName).toBe("SECTION");
    expect(s2.textContent).toMatch(/Erledigt|Offen|Fehler|Wartet|Wird geprüft/);
    for (const b of s2.querySelectorAll("button, a, select")) {
      (b as HTMLElement).focus();
      expect(document.activeElement).toBe(b);
    }
  });

  it("zeigt die Abschlusskarte mit Links, wenn alle 5 erledigt sind", async () => {
    await open();
    expect(await screen.findByLabelText("Fertig", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Zum Cockpit" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Zu den Einstellungen" })).toBeInTheDocument();
  });
});
