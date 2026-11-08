import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { installBackend } from "../test-backend";

let backend: ReturnType<typeof installBackend>;
async function open(prepare?: (b: ReturnType<typeof installBackend>) => void) {
  backend = installBackend(["gamma"]);
  prepare?.(backend);
  history.pushState(null, "", "/h/server/hermes/gamma/lebenszyklus");
  render(<App />);
  await screen.findByRole("heading", { name: "Profile & Betrieb", level: 1 });
}
const sent = (method: string, suffix: string) => backend.calls.filter((c) => c.method === method && c.url.endsWith(suffix));

beforeEach(() => { resetRedirect(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Profil-Lebenszyklus & Betrieb", () => {
  it("lists names as text and offers no server paths", async () => {
    await open();
    const list = await screen.findByRole("region", { name: "Profile" });
    expect(within(list).getByText("gamma")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("/home/");
    expect(document.body.textContent).not.toContain(".hermes/profiles");
  });

  it("shows where a profile's distribution comes from, without credentials", async () => {
    await open((b) => { b.dash.lcProfiles.push("beta"); });
    const region = await screen.findByRole("region", { name: "Profil beta" });
    expect(region).toHaveTextContent("Distribution team-basis 1.2.0 (git.example.test/team/basis.git)");
    expect(screen.getByRole("region", { name: "Profil gamma" })).not.toHaveTextContent("Distribution");
  });

  it("creates a profile by name and checks the name back", async () => {
    await open();
    fireEvent.change(await screen.findByLabelText("Neuer Profilname"), { target: { value: "ecke" } });
    fireEvent.click(screen.getByRole("button", { name: "Profil anlegen" }));
    await screen.findByText(/angelegt/);
    expect(sent("POST", "/hermes-profiles")[0].body).toEqual({ name: "ecke" });
    expect(await screen.findByText("ecke")).toBeInTheDocument();
  });

  it("rejects uppercase names locally before anything travels", async () => {
    await open();
    fireEvent.change(await screen.findByLabelText("Neuer Profilname"), { target: { value: "ECKE" } });
    fireEvent.click(screen.getByRole("button", { name: "Profil anlegen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Kleinbuchstaben");
    expect(sent("POST", "/hermes-profiles")).toHaveLength(0);
  });

  it("renames only to a checked-back name", async () => {
    await open();
    const row = await screen.findByRole("region", { name: "Profil gamma" });
    fireEvent.click(within(row).getByRole("button", { name: "Umbenennen" }));
    fireEvent.change(within(row).getByLabelText("Neuer Name"), { target: { value: "ecke-neu" } });
    fireEvent.click(within(row).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(sent("PATCH", "/hermes-profiles/gamma")[0].body).toEqual({ new_name: "ecke-neu" }));
  });

  it("clones only with an explicit token choice", async () => {
    await open();
    const row = await screen.findByRole("region", { name: "Profil gamma" });
    fireEvent.click(within(row).getByRole("button", { name: "Klonen" }));
    fireEvent.change(within(row).getByLabelText("Kopie heißt"), { target: { value: "ecke-kopie" } });
    fireEvent.click(within(row).getByRole("button", { name: "Klon anlegen" }));
    await waitFor(() => expect(sent("POST", "/hermes-profiles")[0].body).toEqual({ name: "ecke-kopie", clone_from: "gamma", clone_channels: false }));
  });

  it("deletes only after typing the profile name", async () => {
    await open();
    const row = await screen.findByRole("region", { name: "Profil gamma" });
    fireEvent.click(within(row).getByRole("button", { name: "Löschen" }));
    const confirm = within(row).getByLabelText("Zum Bestätigen „gamma“ eintippen");
    const go = within(row).getByRole("button", { name: "Endgültig löschen" });
    expect(go).toBeDisabled();
    fireEvent.change(confirm, { target: { value: "falsch" } });
    expect(go).toBeDisabled();
    fireEvent.change(confirm, { target: { value: "gamma" } });
    fireEvent.click(go);
    await waitFor(() => expect(sent("DELETE", "/hermes-profiles/gamma")[0].body).toEqual({ confirm: "gamma" }));
  });

  it("backs up only after typing the agent name and only as a path note", async () => {
    await open();
    const ops = await screen.findByRole("region", { name: "Sicherung" });
    fireEvent.click(within(ops).getByRole("button", { name: "Sicherung anlegen" }));
    const confirm = within(ops).getByLabelText("Zum Bestätigen „gamma“ eintippen");
    const go = within(ops).getByRole("button", { name: "Sichern" });
    expect(go).toBeDisabled();
    fireEvent.change(confirm, { target: { value: "gamma" } });
    fireEvent.click(go);
    await within(ops).findByText(/Sicherungspfad/);
    expect(sent("POST", "/hermes-ops/backup")[0].body).toEqual({ confirm: "gamma" });
    expect(within(ops).queryByRole("link", { name: /Herunterladen/ })).not.toBeInTheDocument();
  });

  it("imports only an uploaded archive, never a typed path", async () => {
    await open();
    const ops = await screen.findByRole("region", { name: "Import" });
    expect(within(ops).queryByLabelText(/Serverpfad|Pfad/)).not.toBeInTheDocument();
    const file = within(ops).getByLabelText("Archivdatei (.tar.gz, .tgz, .zip)");
    const data = new File(["PK-test"], "profil.tar.gz", { type: "application/gzip" });
    fireEvent.change(file, { target: { files: [data] } });
    fireEvent.click(within(ops).getByRole("button", { name: "Importieren" }));
    await within(ops).findByText(/importiert/);
    expect(sent("POST", "/hermes-profiles/import").length).toBe(1);
  });

  it("rejects oversized archives locally", async () => {
    await open();
    const ops = await screen.findByRole("region", { name: "Import" });
    const big = new File([new ArrayBuffer(51 * 1024 * 1024)], "gross.tar.gz", { type: "application/gzip" });
    fireEvent.change(within(ops).getByLabelText("Archivdatei (.tar.gz, .tgz, .zip)"), { target: { files: [big] } });
    fireEvent.click(within(ops).getByRole("button", { name: "Importieren" }));
    expect(await within(ops).findByRole("alert")).toHaveTextContent("50 MB");
    expect(sent("POST", "/hermes-profiles/import").length).toBe(0);
  });

  it("shows the shared-filesystem error banner on a denied profile import", async () => {
    await open((b) => { b.dash.kbImportFail = "NOT_SHARED Die Datei liegt nicht im Dateisystem der WebUI"; });
    const ops = await screen.findByRole("region", { name: "Import" });
    const data = new File(["PK-test"], "profil.tar.gz", { type: "application/gzip" });
    fireEvent.change(within(ops).getByLabelText("Archivdatei (.tar.gz, .tgz, .zip)"), { target: { files: [data] } });
    fireEvent.click(within(ops).getByRole("button", { name: "Importieren" }));
    expect(await within(ops).findByRole("alert")).toHaveTextContent("NOT_SHARED");
  });

  it("offers no update, no migrate, no dump, no debug share", async () => {
    await open();
    await screen.findByRole("region", { name: "Profile" });
    for (const word of ["Aktualisieren", "Migrieren", "Dump", "Debug"]) {
      expect(screen.queryByRole("button", { name: new RegExp(word) })).not.toBeInTheDocument();
    }
    expect(document.body.textContent).not.toContain("curl");
  });

  it("asks for a fresh login when a change needs one", async () => {
    await open((b) => { b.dash.stepUp = true; });
    fireEvent.change(await screen.findByLabelText("Neuer Profilname"), { target: { value: "ecke" } });
    fireEvent.click(screen.getByRole("button", { name: "Profil anlegen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("frische Anmeldung");
  });

  it("says so when the host has no dashboard", async () => {
    await open((b) => { b.dash.available = false; });
    expect(await screen.findByRole("alert")).toHaveTextContent("kein Dashboard");
  });

  it("lists checkpoints without paths and prunes only after typing the agent name", async () => {
    await open();
    const box = await screen.findByRole("region", { name: "Checkpoints" });
    fireEvent.click(within(box).getByRole("button", { name: "Laden" }));
    await within(box).findByText(/run_aaa/);
    expect(box.textContent).not.toContain("/opt/");
    fireEvent.click(within(box).getByRole("button", { name: "Aufräumen" }));
    const go = within(box).getByRole("button", { name: "Endgültig aufräumen" });
    expect(go).toBeDisabled();
    fireEvent.change(within(box).getByLabelText("Zum Bestätigen „gamma“ eintippen"), { target: { value: "gamma" } });
    fireEvent.click(go);
    await within(box).findByText("Keine Checkpoints.");
    expect(sent("POST", "/hermes-ops/checkpoints/prune")[0].body).toEqual({ confirm: "gamma" });
  });

  it("starts the security audit and shows its log", async () => {
    await open();
    const box = await screen.findByRole("region", { name: "Sicherheitsprüfung" });
    fireEvent.click(within(box).getByRole("button", { name: "Prüfung starten" }));
    await within(box).findByText("2 Hinweise");
  });

  it("drains only after typing the word, cancel needs none", async () => {
    await open();
    const box = await screen.findByRole("region", { name: "Gateway leeren" });
    fireEvent.click(within(box).getByRole("button", { name: "Leeren" }));
    const go = within(box).getByRole("button", { name: "Gateway leeren" });
    expect(go).toBeDisabled();
    fireEvent.change(within(box).getByLabelText("Zum Bestätigen „leeren“ eintippen"), { target: { value: "leeren" } });
    fireEvent.click(go);
    await within(box).findByText("Das Gateway wird geleert.");
    fireEvent.click(within(box).getByRole("button", { name: "Leeren abbrechen" }));
    await within(box).findByText("Leeren abgebrochen.");
    expect(sent("POST", "/gateway/drain").map((c) => (c.body as { action: string }).action)).toEqual(["drain", "cancel"]);
  });

  it("shows the update receipt and the read-only configuration", async () => {
    await open();
    const rc = await screen.findByRole("region", { name: "Update-Beleg" });
    fireEvent.click(within(rc).getByRole("button", { name: "Laden" }));
    await within(rc).findByText("0.22.5");
    expect(within(rc).getByText("Gateway neu starten")).toBeInTheDocument(); // offene Folgeschritte
    expect(within(rc).getByText(/hermes setup ausführen/)).toBeInTheDocument();
    const cf = screen.getByRole("region", { name: "Konfiguration lesen" });
    fireEvent.click(within(cf).getByRole("button", { name: "config.yaml" }));
    await within(cf).findByText(/backend: local/);
    expect(within(cf).getByLabelText("config.yaml").textContent).not.toContain("/home");
    expect(sent("PUT", "/hermes-config/raw")).toHaveLength(0);
  });
});
