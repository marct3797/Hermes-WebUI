import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAUTION, FakeBff } from "../fixtures/extFake";
import { MarketplacePage } from "./MarketplacePage";

vi.mock("../hosts", () => ({ useHosts: () => ({ hosts: [{ id: "server", label: "Server", runtimes: [] }] }) }));
let bff: FakeBff;
beforeEach(() => { bff = new FakeBff(); vi.stubGlobal("fetch", vi.fn(bff.handle)); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const tab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));

describe("Marktplatz", () => {
  it("zeigt Empfohlenes mit Vertrauensstufe und Status und sucht über die gewählte Quelle", async () => {
    render(<MarketplacePage host="server" />);
    const card = await screen.findByRole("button", { name: "1password ansehen" });
    expect(card).toHaveTextContent("Offiziell");
    expect(screen.getByRole("button", { name: "get-pr-review ansehen" })).toHaveTextContent("Community");
    expect(screen.getByRole("button", { name: "get-pr-review ansehen" })).toHaveTextContent("installiert");
    expect(screen.getByText(/Ergebnisse \(Empfohlen\)/)).toBeInTheDocument();
    fireEvent.change(await screen.findByRole("combobox", { name: "Quelle" }), { target: { value: "browse-sh" } });
    fireEvent.change(screen.getByRole("searchbox", { name: "Skills suchen" }), { target: { value: "review" } });
    fireEvent.click(screen.getByRole("button", { name: "Suchen" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "1password ansehen" })).not.toBeInTheDocument());
    const q = bff.calls.filter((c) => c.path.endsWith("/_market/skills")).at(-1)!.query;
    expect(q.get("q")).toBe("review");
    expect(q.get("source")).toBe("browse-sh");
    expect(q.get("profile")).toBe("default");
  });

  it("zeigt die Vorschau mit Scan-Warnung und installiert erst nach Zustimmung in zwei Profile", async () => {
    bff.scan = CAUTION;
    render(<MarketplacePage host="server" />);
    fireEvent.click(await screen.findByRole("button", { name: "1password ansehen" }));
    const dlg = await screen.findByRole("dialog", { name: "Vorschau 1password" });
    expect(await within(dlg).findByRole("heading", { name: "Vorschau-Titel" })).toBeInTheDocument();
    expect(within(dlg).getByText("SKILL.md, run.sh")).toBeInTheDocument();
    expect(await within(dlg).findByText("Ruft eine Adresse ab")).toBeInTheDocument();
    expect(within(dlg).getByRole("region", { name: "Sicherheitsprüfung" })).toHaveTextContent("Vorsicht");
    expect(within(dlg).getAllByRole("alert")[0]).toHaveTextContent("Die Prüfung meldet Funde");
    fireEvent.click(within(dlg).getByRole("checkbox", { name: "beta" }));
    fireEvent.click(within(dlg).getByRole("button", { name: "Installieren in 2 Profil(en)" }));
    expect(bff.find("POST", "/skills/install")).toHaveLength(0);
    const go = within(dlg).getByRole("button", { name: "Jetzt installieren" });
    expect(go).toBeDisabled();
    fireEvent.click(within(dlg).getByRole("checkbox", { name: /Funde gelesen/ }));
    expect(go).toBeEnabled();
    fireEvent.click(go);
    expect(await within(dlg).findByText("Installation gestartet.")).toBeInTheDocument();
    expect(bff.find("POST", "/skills/install")[0].body).toEqual({ identifier: "official/security/1password", profiles: ["default", "beta"], accept_risk: true });
    expect(within(dlg).getByText("beta: gestartet")).toBeInTheDocument();
  });

  it("installiert eine saubere Prüfung ohne Zusatz-Zustimmung und blockiert verbotene", async () => {
    render(<MarketplacePage host="server" />);
    fireEvent.click(await screen.findByRole("button", { name: "1password ansehen" }));
    let dlg = await screen.findByRole("dialog", { name: "Vorschau 1password" });
    const start = await within(dlg).findByRole("button", { name: "Installieren in 1 Profil(en)" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    expect(within(dlg).queryByRole("checkbox", { name: /Funde gelesen/ })).not.toBeInTheDocument();
    fireEvent.click(within(dlg).getByRole("button", { name: "Jetzt installieren" }));
    await waitFor(() => expect(bff.find("POST", "/skills/install")[0].body).toEqual({ identifier: "official/security/1password", profiles: ["default"], accept_risk: false }));
    cleanup();
    bff.scan = { ...CAUTION, verdict: "dangerous", policy: "block", summary: "gefährlich" };
    render(<MarketplacePage host="server" />);
    fireEvent.click(await screen.findByRole("button", { name: "1password ansehen" }));
    dlg = await screen.findByRole("dialog", { name: "Vorschau 1password" });
    expect(await within(dlg).findByText(/Blockiert:/)).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Installieren in 1 Profil(en)" })).toBeDisabled();
  });

  it("installiert nicht, wenn die Sicherheitsprüfung scheitert", async () => {
    bff.failWith["/skills/scan"] = { status: 502, detail: "Hub scan failed" };
    render(<MarketplacePage host="server" />);
    fireEvent.click(await screen.findByRole("button", { name: "1password ansehen" }));
    const dlg = await screen.findByRole("dialog", { name: "Vorschau 1password" });
    expect(await within(dlg).findByText(/Ohne Prüfergebnis wird nicht installiert/)).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Installieren in 1 Profil(en)" })).toBeDisabled();
  });
});

describe("Marktplatz: Quellen", () => {
  it("fügt eine Quelle hinzu und entfernt sie nach Bestätigung", async () => {
    render(<MarketplacePage host="server" />);
    await screen.findByRole("button", { name: "1password ansehen" });
    tab("Quellen");
    expect(await screen.findByText("Offizielles MCP-Registry")).toBeInTheDocument();
    expect(screen.getByText("Official")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Official.*entfernen/ })).not.toBeInTheDocument();  // vorinstalliert: nicht löschbar
    const form = screen.getByRole("form", { name: "Quelle hinzufügen" });
    const add = within(form).getByRole("button", { name: "Quelle hinzufügen" });
    expect(add).toBeDisabled();
    fireEvent.change(within(form).getByRole("textbox", { name: "Ziel" }), { target: { value: "owner/repo/skills" } });
    fireEvent.change(within(form).getByRole("textbox", { name: "Beschriftung" }), { target: { value: "Meine Skills" } });
    fireEvent.click(add);
    expect(await screen.findByRole("button", { name: "Meine Skills entfernen" })).toBeInTheDocument();
    expect(bff.find("POST", "/bff/market/sources")[0].body).toEqual({ label: "Meine Skills", kind: "github", target: "owner/repo/skills" });
    fireEvent.click(screen.getByRole("button", { name: "Meine Skills entfernen" }));
    expect(bff.find("DELETE", "/bff/market/sources/")).toHaveLength(0);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Quelle entfernen?" })).getByRole("button", { name: "Entfernen" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Meine Skills entfernen" })).not.toBeInTheDocument());
    expect(bff.find("DELETE", "/bff/market/sources/")).toHaveLength(1);
  });

  it("zeigt Fehler beim Hinzufügen mit Grund", async () => {
    render(<MarketplacePage host="server" />);
    tab("Quellen");
    bff.failWith["POST /bff/market/sources"] = { status: 422, detail: "Die Adresse zeigt auf ein nicht öffentliches Netz und wird nicht abgerufen" };
    const form = await screen.findByRole("form", { name: "Quelle hinzufügen" });
    fireEvent.change(within(form).getByRole("combobox", { name: "Art" }), { target: { value: "mcp-registry" } });
    fireEvent.change(within(form).getByRole("textbox", { name: "Ziel" }), { target: { value: "https://intern.example" } });
    fireEvent.change(within(form).getByRole("textbox", { name: "Beschriftung" }), { target: { value: "Intern" } });
    fireEvent.click(within(form).getByRole("button", { name: "Quelle hinzufügen" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("nicht öffentliches Netz");
  });

  it("listet MCP-Registry-Einträge und füllt das Formular vor", async () => {
    render(<MarketplacePage host="server" />);
    tab("MCP-Connectoren");
    fireEvent.change(await screen.findByRole("combobox", { name: "MCP-Quelle" }), { target: { value: "official" } });
    fireEvent.click(await screen.findByRole("button", { name: "io.example/alpha-mcp ansehen" }));
    fireEvent.click(await screen.findByRole("button", { name: "Als Server hinzufügen" }));
    const dlg = screen.getByRole("dialog", { name: "MCP-Server hinzufügen" });
    expect((within(dlg).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("alpha-mcp");
    expect((within(dlg).getByRole("textbox", { name: "Befehl" }) as HTMLInputElement).value).toBe("npx");
    expect((within(dlg).getByRole("textbox", { name: "Umgebungsvariablen" }) as HTMLTextAreaElement).value).toBe("ALPHA_TOKEN=");
  });
});
