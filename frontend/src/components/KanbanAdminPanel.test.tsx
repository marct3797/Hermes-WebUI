import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRedirect } from "../api";
import { installBackend } from "../test-backend";
import { KanbanAdminPanel } from "./KanbanAdminPanel";

let backend: ReturnType<typeof installBackend>;
const sent = (method: string, part: string) => backend.calls.filter((c) => c.method === method && c.url.includes(part));
const open = (onChanged: () => void = () => undefined, onImported: (s: string) => void = () => undefined) => { backend = installBackend(["gamma"]); render(<KanbanAdminPanel host="server" board="default" onChanged={onChanged} onImported={onImported} />); };

beforeEach(() => { resetRedirect(); sessionStorage.clear(); vi.spyOn(window, "confirm").mockReturnValue(true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Kanban Diagnose und Betrieb", () => {
  it("shows diagnostics for the chosen board", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Diagnose laden" }));
    await screen.findByText(/Aufgabe blockiert/);
    expect(sent("GET", "/_kanban/diagnostics")[0].url).toContain("board=default");
  });

  it("ends a run only after typing the run number", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Laufende Worker laden" }));
    const btn = await screen.findByRole("button", { name: "Lauf 7 beenden" });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Lauf-Nummer zum Beenden 7"), { target: { value: "8" } });
    expect(screen.getByRole("button", { name: "Lauf 7 beenden" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Lauf-Nummer zum Beenden 7"), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Lauf 7 beenden" }));
    await screen.findByText("Keine Worker aktiv.");
    expect(sent("POST", "/runs/7/terminate")[0].body).toEqual({ confirm: "7" });
  });

  it("previews the dispatch first and only then offers to start", async () => {
    open();
    expect(screen.getByRole("button", { name: "Worker jetzt starten" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Vorschau: was würde starten?" }));
    await screen.findByText(/1 würden starten \(t_1\)/);
    expect(sent("POST", "/_kanban/dispatch")[0].body).toEqual({ dry_run: true });
    fireEvent.click(screen.getByRole("button", { name: "Worker jetzt starten" }));
    await screen.findByText("1 Worker gestartet");
    expect(sent("POST", "/_kanban/dispatch")[1].body).toEqual({ dry_run: false, confirm_spawn: true });
    expect(screen.getByRole("button", { name: "Worker jetzt starten" })).toBeDisabled();
  });

  it("does not offer to start when the preview finds nothing", async () => {
    open();
    backend.dash.p3.spawnNone = true;
    fireEvent.click(screen.getByRole("button", { name: "Vorschau: was würde starten?" }));
    await screen.findByText(/0 würden starten \(keine\)/);
    expect(screen.getByRole("button", { name: "Worker jetzt starten" })).toBeDisabled();
  });

  it("asks before specifying and sends the confirmation", async () => {
    open();
    fireEvent.change(screen.getByLabelText("Aufgaben-ID"), { target: { value: "t_1" } });
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Aufgabe spezifizieren" }));
    expect(sent("POST", "/specify")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Aufgabe spezifizieren" }));
    await screen.findByText(/Neu formuliert: Klarer Titel/);
    expect(sent("POST", "/specify")[0].body).toEqual({ confirm: true });
  });

  it("estimates the effort and asks for a fresh login when required", async () => {
    open();
    fireEvent.change(screen.getByLabelText("Aufgaben-ID"), { target: { value: "t_1" } });
    fireEvent.click(screen.getByRole("button", { name: "Aufwand schätzen" }));
    await screen.findByText(/1200 Tokens, Komplexität M/);
    backend.dash.stepUp = true;
    fireEvent.click(screen.getByRole("button", { name: "Aufwand schätzen" }));
    await waitFor(() => expect(screen.getByText(/erneut anmelden/i)).toBeTruthy());
  });

  it("asks before decomposing and shows the children", async () => {
    open();
    fireEvent.change(screen.getByLabelText("Aufgaben-ID"), { target: { value: "t_1" } });
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Aufgabe zerlegen" }));
    expect(sent("POST", "/decompose")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Aufgabe zerlegen" }));
    await screen.findByText(/Zerlegt in: t_9, t_10/);
    expect(sent("POST", "/decompose")[0].body).toEqual({ confirm: true });
  });

  it("exports, imports and archives a board", async () => {
    Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined });
    const changed: string[] = []; const imported: string[] = [];
    open(() => changed.push("x"), (s) => imported.push(s));
    fireEvent.click(screen.getByRole("button", { name: "Board exportieren" }));
    await screen.findByText("Export gespeichert: default.tar.gz");
    expect(sent("POST", "/boards/default/export")).toHaveLength(1);
    const file = new File([JSON.stringify({ sessions: [] })], "b.tar.gz", { type: "application/gzip" });
    fireEvent.change(screen.getByLabelText("Archivdatei"), { target: { files: [file] } });
    await screen.findByText("Importiert: importiert");
    expect(imported).toEqual(["importiert"]);
    fireEvent.change(screen.getByLabelText("Board-Namen zur Bestätigung eingeben"), { target: { value: "defaul" } });
    expect(screen.getByRole("button", { name: "Board archivieren" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Board-Namen zur Bestätigung eingeben"), { target: { value: "default" } });
    fireEvent.click(screen.getByRole("button", { name: "Board archivieren" }));
    await screen.findByText("Archiviert: default");
    expect(changed).toEqual(["x"]);
  });

  it("shows the shared-filesystem error banner on a denied board import", async () => {
    backend = installBackend(["gamma"]); backend.dash.p3.kbImportFail = "NOT_SHARED Die Datei liegt nicht im Dateisystem der WebUI";
    render(<KanbanAdminPanel host="server" board="default" onChanged={() => undefined} onImported={() => undefined} />);
    const file = new File(["PK-test"], "b.tar.gz", { type: "application/gzip" });
    fireEvent.change(screen.getByLabelText("Archivdatei"), { target: { files: [file] } });
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("NOT_SHARED");
  });
});
