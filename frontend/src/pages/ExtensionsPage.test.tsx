import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeBff } from "../fixtures/extFake";
import { ExtensionsPage } from "./ExtensionsPage";

vi.mock("../hosts", () => ({ useHosts: () => ({ hosts: [{ id: "server", label: "Server", runtimes: [] }] }) }));
let bff: FakeBff;
beforeEach(() => { bff = new FakeBff(); vi.stubGlobal("fetch", vi.fn(bff.handle)); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const typeInto = (name: string, value: string) => fireEvent.change(screen.getByRole("textbox", { name }), { target: { value } });
const tab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));

describe("Erweiterungen: Skills", () => {
  it("schaltet einen Skill ein und aus", async () => {
    render(<ExtensionsPage host="server" />);
    const sw = await screen.findByRole("switch", { name: "gamma aktiv" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    fireEvent.click(sw);
    await waitFor(() => expect(screen.getByRole("switch", { name: "gamma aktiv" })).toHaveAttribute("aria-checked", "true"));
    expect(bff.find("PUT", "/skills/gamma/enabled")[0].body).toEqual({ enabled: true });
  });

  it("öffnet den Editor, speichert und verwirft Änderungen", async () => {
    render(<ExtensionsPage host="server" />);
    fireEvent.click(await screen.findByRole("button", { name: "Skill claude-code öffnen" }));
    const area = await screen.findByRole("textbox", { name: "Inhalt von SKILL.md" });
    await waitFor(() => expect((area as HTMLTextAreaElement).value).toContain("# Claude Code"));
    expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();
    fireEvent.change(area, { target: { value: "---\nname: claude-code\ndescription: Neu\n---\nNeu" } });
    expect(screen.getByRole("status")).toHaveTextContent("Ungespeicherte Änderungen");
    fireEvent.click(screen.getByRole("button", { name: "Verwerfen" }));
    expect((area as HTMLTextAreaElement).value).toContain("# Claude Code");
    fireEvent.change(area, { target: { value: "---\nname: claude-code\ndescription: Neu\n---\nNeu" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(screen.getByText("Gespeichert")).toBeInTheDocument());
    expect(bff.find("PUT", "/skills/claude-code")[0].body).toEqual({ content: "---\nname: claude-code\ndescription: Neu\n---\nNeu" });
    fireEvent.click(screen.getByRole("tab", { name: "Vorschau" }));
    expect(screen.getByLabelText("Vorschau")).toHaveTextContent("Neu");
  });

  it("zeigt Fehler des Speicherns lesbar und warnt vor ungespeicherten Änderungen beim Wechsel", async () => {
    render(<ExtensionsPage host="server" />);
    fireEvent.click(await screen.findByRole("button", { name: "Skill claude-code öffnen" }));
    const area = await screen.findByRole("textbox", { name: "Inhalt von SKILL.md" });
    await waitFor(() => expect((area as HTMLTextAreaElement).value).not.toBe(""));
    bff.failWith["PUT /bff/h/server/_ext/default/skills/claude-code"] = { status: 422, detail: "Im Frontmatter fehlt die Zeile name:" };
    fireEvent.change(area, { target: { value: "kaputt" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Im Frontmatter fehlt die Zeile name:");
    fireEvent.click(screen.getByRole("button", { name: "Skill gamma öffnen" }));
    const dlg = await screen.findByRole("dialog", { name: "Ungespeicherte Änderungen verwerfen?" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Abbrechen" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Ungespeicherte Änderungen verwerfen?" })).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "claude-code" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Skill gamma öffnen" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Ungespeicherte Änderungen verwerfen?" })).getByRole("button", { name: "Verwerfen" }));
    expect(await screen.findByRole("heading", { name: "gamma" })).toBeInTheDocument();
  });

  it("legt einen neuen Skill mit Vorlage an und öffnet ihn", async () => {
    render(<ExtensionsPage host="server" />);
    fireEvent.click(await screen.findByRole("button", { name: "Neuer Skill" }));
    const create = screen.getByRole("button", { name: "Skill anlegen" });
    expect(create).toBeDisabled();
    typeInto("Name", "delta");
    typeInto("Kategorie", "werkzeuge");
    expect((screen.getByRole("textbox", { name: "Inhalt" }) as HTMLTextAreaElement).value).toContain("name: delta");
    fireEvent.click(create);
    await waitFor(() => expect(bff.find("POST", "/_ext/default/skills")).toHaveLength(1));
    expect(bff.find("POST", "/_ext/default/skills")[0].body).toMatchObject({ name: "delta", category: "werkzeuge" });
    expect(await screen.findByRole("heading", { name: "delta" })).toBeInTheDocument();
  });

  it("deinstalliert Hub-Skills nur nach Bestätigung", async () => {
    render(<ExtensionsPage host="server" />);
    fireEvent.click(await screen.findByRole("button", { name: "Skill gamma öffnen" }));
    fireEvent.click(await screen.findByRole("button", { name: "Deinstallieren" }));
    expect(bff.find("DELETE", "/skills/gamma")).toHaveLength(0);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Skill deinstallieren?" })).getByRole("button", { name: "Deinstallieren" }));
    await waitFor(() => expect(bff.find("DELETE", "/skills/gamma")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Skill gamma öffnen" })).not.toBeInTheDocument());
  });

  it("filtert per Suche und wechselt das Profil", async () => {
    render(<ExtensionsPage host="server" />);
    await screen.findByRole("button", { name: "Skill gamma öffnen" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Skills durchsuchen" }), { target: { value: "hub" } });
    expect(screen.queryByRole("button", { name: "Skill claude-code öffnen" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Profil" }), { target: { value: "beta" } });
    await waitFor(() => expect(bff.calls.some((c) => c.path === "/bff/h/server/_ext/beta/skill-list")).toBe(true));
  });
});

describe("Erweiterungen: MCP", () => {
  it("fügt einen stdio-Server hinzu, ohne Env-Werte wieder zu zeigen", async () => {
    render(<ExtensionsPage host="server" />);
    await screen.findByRole("button", { name: "Skill gamma öffnen" });
    tab("MCP");
    fireEvent.click(await screen.findByRole("button", { name: "Server hinzufügen" }));
    const dlg = screen.getByRole("dialog", { name: "MCP-Server hinzufügen" });
    const submit = within(dlg).getByRole("button", { name: "Server hinzufügen" });
    expect(submit).toBeDisabled();
    typeInto("Name", "alpha-db");
    typeInto("Befehl", "npx");
    typeInto("Argumente", "-y\npaket");
    typeInto("Umgebungsvariablen", "DB_KEY=streng-geheim");
    fireEvent.click(submit);
    await waitFor(() => expect(bff.find("POST", "/_ext/default/mcp")).toHaveLength(1));
    expect(bff.find("POST", "/_ext/default/mcp")[0].body).toEqual({ name: "alpha-db", transport: "stdio", command: "npx", args: ["-y", "paket"], env: { DB_KEY: "streng-geheim" } });
    expect(await screen.findByRole("heading", { name: "alpha-db" })).toBeInTheDocument();
    expect(screen.getByText(/DB_KEY \(gesetzt\)/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("streng-geheim");
  });

  it("prüft das Formular für http mit Bearer-Token", async () => {
    render(<ExtensionsPage host="server" />);
    tab("MCP");
    fireEvent.click(await screen.findByRole("button", { name: "Server hinzufügen" }));
    const dlg = screen.getByRole("dialog", { name: "MCP-Server hinzufügen" });
    fireEvent.click(within(dlg).getByRole("radio", { name: /http/ }));
    typeInto("Name", "web2");
    typeInto("URL", "ftp://example.com");
    expect(within(dlg).getByText(/URL muss mit http/)).toBeInTheDocument();
    typeInto("URL", "https://example.com/mcp");
    fireEvent.change(within(dlg).getByRole("combobox", { name: "Anmeldung" }), { target: { value: "header" } });
    expect(within(dlg).getByText("Bearer-Token fehlt")).toBeInTheDocument();
    fireEvent.change(within(dlg).getByLabelText("Bearer-Token"), { target: { value: "tok-123" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Server hinzufügen" }));
    await waitFor(() => expect(bff.find("POST", "/_ext/default/mcp")).toHaveLength(1));
    expect(bff.find("POST", "/_ext/default/mcp")[0].body).toEqual({ name: "web2", transport: "http", url: "https://example.com/mcp", auth: "header", bearer_token: "tok-123" });
    await screen.findByRole("heading", { name: "web2" });
    expect(document.body.textContent).not.toContain("tok-123");
  });

  it("testet einen Server, startet die Anmeldung und entfernt ihn nach Bestätigung", async () => {
    render(<ExtensionsPage host="server" />);
    tab("MCP");
    fireEvent.click(await screen.findByRole("button", { name: "Server web öffnen" }));
    fireEvent.click(await screen.findByRole("button", { name: "Verbindung testen" }));
    expect((await screen.findByText(/Verbindung steht/)).parentElement).toHaveTextContent("2 Werkzeuge");
    expect(screen.getByText("search")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(await screen.findByRole("link", { name: "Seite des Anbieters öffnen" })).toHaveAttribute("href", "https://auth.example.com/authorize");
    fireEvent.click(screen.getByRole("button", { name: "Entfernen" }));
    expect(bff.find("DELETE", "/mcp/web")).toHaveLength(0);
    fireEvent.click(within(screen.getByRole("dialog", { name: "MCP-Server entfernen?" })).getByRole("button", { name: "Entfernen" }));
    await waitFor(() => expect(bff.find("DELETE", "/mcp/web")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Server web öffnen" })).not.toBeInTheDocument());
  });

  it("zeigt einen fehlgeschlagenen Test mit Grund", async () => {
    render(<ExtensionsPage host="server" />);
    tab("MCP");
    fireEvent.click(await screen.findByRole("button", { name: "Server rag öffnen" }));
    bff.failWith["/mcp/rag/test"] = { status: 502, detail: "Das Dashboard antwortet nicht" };
    fireEvent.click(await screen.findByRole("button", { name: "Verbindung testen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Das Dashboard antwortet nicht");
  });

  it("schaltet Server ein und aus", async () => {
    render(<ExtensionsPage host="server" />);
    tab("MCP");
    fireEvent.click(await screen.findByRole("switch", { name: "rag aktiv" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "rag aktiv" })).toHaveAttribute("aria-checked", "false"));
    expect(bff.find("PUT", "/mcp/rag/enabled")[0].body).toEqual({ enabled: false });
  });

  it("installiert aus dem Katalog mit Env-Formular", async () => {
    render(<ExtensionsPage host="server" />);
    tab("MCP");
    fireEvent.click(await screen.findByRole("button", { name: "Aus Katalog installieren" }));
    fireEvent.click(await screen.findByRole("button", { name: "beta-db ansehen" }));
    const dlg = screen.getByRole("dialog", { name: "beta-db installieren" });
    fireEvent.change(within(dlg).getByLabelText("BETA_DB_KEY"), { target: { value: "wert" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Installieren" }));
    await waitFor(() => expect(bff.find("POST", "/mcp/catalog/install")).toHaveLength(1));
    expect(bff.find("POST", "/mcp/catalog/install")[0].body).toEqual({ name: "beta-db", env: { BETA_DB_KEY: "wert" }, enable: true });
  });
});

describe("Erweiterungen: Plugins", () => {
  it("schaltet Plugins ein und aus und sperrt Entfernen für mitgelieferte", async () => {
    render(<ExtensionsPage host="server" />);
    tab("Plugins");
    fireEvent.click(await screen.findByRole("switch", { name: "beta-plugin aktiv" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "beta-plugin aktiv" })).toHaveAttribute("aria-checked", "true"));
    expect(bff.find("POST", "/plugins/beta-plugin/enable")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Plugin browser-firecrawl öffnen" }));
    expect(await screen.findByRole("button", { name: "Entfernen" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Plugin beta-plugin öffnen" }));
    fireEvent.click(await screen.findByRole("button", { name: "Entfernen" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Plugin entfernen?" })).getByRole("button", { name: "Entfernen" }));
    await waitFor(() => expect(bff.find("DELETE", "/plugins/beta-plugin")).toHaveLength(1));
  });

  it("installiert ein Plugin per Git-Kennung nur nach Bestätigung und prüft die Kennung", async () => {
    render(<ExtensionsPage host="server" />);
    tab("Plugins");
    const input = await screen.findByRole("textbox", { name: "Plugin-Kennung" });
    const go = screen.getByRole("button", { name: "Plugin installieren" });
    fireEvent.change(input, { target: { value: "../etc" } });
    expect(go).toBeDisabled();
    fireEvent.change(input, { target: { value: "owner/repo" } });
    fireEvent.click(go);
    expect(bff.find("POST", "/plugins/install")).toHaveLength(0);
    fireEvent.click(within(screen.getByRole("dialog", { name: "owner/repo installieren?" })).getByRole("button", { name: "Installieren" }));
    await waitFor(() => expect(bff.find("POST", "/plugins/install")).toHaveLength(1));
    expect(bff.find("POST", "/plugins/install")[0].body).toEqual({ identifier: "owner/repo" });
  });
});
