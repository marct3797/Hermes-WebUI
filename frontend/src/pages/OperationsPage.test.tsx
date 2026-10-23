import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperationsPage } from "./OperationsPage";

vi.mock("../hosts", () => ({ useHosts: () => ({ hosts: [{ id: "hikari", label: "Hikari", runtimes: [{ id: "hermes", agents: [{ id: "default", label: "Standard" }] }] }] }) }));
const catalog = { profiles: [{ id: "default" }], sources: [] };
let calls: { url: string; init?: RequestInit }[];
let response: Record<string, unknown>;
beforeEach(() => {
  calls = [];
  response = {};
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const body = url.endsWith("/_manage") ? catalog : response;
    return new Response(JSON.stringify(body), { status: 200 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Operations", () => {
  it("shows loading while the host catalog is pending", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    render(<OperationsPage section="manage" host="hikari" />);
    expect(await screen.findByRole("status")).toHaveTextContent("Daten werden geladen");
  });
  it("keeps rejected writes visible and allows Escape cancellation", async () => {
    response = { available: true, items: [{ id: "plugin-a", name: "Analyse", actions: ["disable"] }] };
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => init?.method === "POST" ? new Response("{}", { status: 403 }) : original(url, init)));
    render(<OperationsPage section="manage" host="hikari" />);
    fireEvent.click(await screen.findByRole("button", { name: "Deaktivieren" }));
    fireEvent.click(screen.getByRole("button", { name: "Bestätigen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Berechtigung fehlt");
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
  it("displays the actual BFF discovery-only catalog without install controls", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...catalog, sources: [{ id: "mcp-registry", label: "Official MCP Registry", url: "https://registry.modelcontextprotocol.io", kinds: ["mcp"], installable: false, trust: "Discovery only" }] }))));
    render(<OperationsPage section="marketplaces" host="hikari" />);
    expect(await screen.findByRole("link", { name: "Quelle öffnen" })).toHaveAttribute("href", "https://registry.modelcontextprotocol.io");
    expect(screen.queryByRole("button", { name: "Installieren" })).not.toBeInTheDocument();
  });
  it("offers native jobs administration only with the runtime jobs capability", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/status") ? { features: ["jobs"] } : { jobs: [{ id: "abc123def456", name: "Nativer Job", schedule: "0 8 * * *", paused: false }] }))));
    render(<OperationsPage section="jobs" host="hikari" />);
    await screen.findByText("Nativer Job");
    expect(await screen.findByRole("button", { name: "Pausieren" })).toBeInTheDocument();
  });
  it("renders the daemon native read-only Kanban items contract", async () => {
    response = { available: true, items: [{ id: "t2", title: "Native Aufgabe", status: "ready", assignee: null, priority: "high" }], actions: [], truncated: true };
    render(<OperationsPage section="kanban" host="hikari" />);
    expect(await screen.findByText("Native Aufgabe")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "ready" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verschieben" })).not.toBeInTheDocument();
  });
  it("uses actual daemon collection actions and displays native restrictions", async () => {
    response = { available: true, items: [{ id: "plugin-a", enabled: true }], actions: ["enable", "disable"], note: "Native Freigabe erforderlich" };
    render(<OperationsPage section="manage" host="hikari" />);
    await screen.findByText("plugin-a");
    expect(screen.getByText("Native Freigabe erforderlich")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deaktivieren" })).toBeInTheDocument();
  });
  it("accepts the server-redacted native logs contract", async () => {
    response = { available: true, content: "[redacted]", truncated: false, items: [], actions: [] };
    render(<OperationsPage section="logs" host="hikari" />);
    expect(await screen.findByText("[redacted]")).toBeInTheDocument();
  });
  it("loads real native Kanban columns and only advertised transitions", async () => {
    response = { available: true, columns: ["todo", "done"], tasks: [{ id: "t1", title: "Prüfen", status: "todo", transitions: ["done"] }] };
    render(<OperationsPage section="kanban" host="hikari" />);
    await screen.findByText("Prüfen");
    expect(screen.getByRole("heading", { name: "todo" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Status für Prüfen"), { target: { value: "done" } });
    fireEvent.click(screen.getByRole("button", { name: "Verschieben" }));
    expect(calls.filter(c => c.init?.method === "POST")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Bestätigen" }));
    await waitFor(() => expect(calls.some(c => c.url.endsWith("/kanban/transition"))).toBe(true));
    expect(JSON.parse(calls.find(c => c.init?.method === "POST")!.init!.body as string)).toEqual({ id: "t1", status: "done" });
  });
  it("shows empty native boards without creating tasks", async () => {
    response = { available: true, columns: [], tasks: [] };
    render(<OperationsPage section="kanban" host="hikari" />);
    await screen.findByText("Keine Aufgaben vorhanden.");
    expect(calls.every(c => !c.init?.method)).toBe(true);
  });
  it("distinguishes unsupported from unconfigured", async () => {
    response = { available: false, reason: "Native Kanban API fehlt", configured: true };
    render(<OperationsPage section="kanban" host="hikari" />);
    await screen.findByText(/Nicht unterstützt: Native Kanban API fehlt/);
  });
  it("shows HTTP permission failures and retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "fresh_auth_required" }), { status: 403 })));
    render(<OperationsPage section="manage" host="hikari" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Berechtigung fehlt");
    expect(screen.getByRole("button", { name: "Erneut laden" })).toBeInTheDocument();
  });
  it("does not invent management actions", async () => {
    response = { available: true, items: [{ id: "skill-a", name: "Analyse", enabled: true }] };
    render(<OperationsPage section="manage" host="hikari" />);
    await screen.findByText("Analyse");
    expect(screen.queryByRole("button", { name: "Deaktivieren" })).not.toBeInTheDocument();
  });
  it("confirms capability-gated management writes and sends CSRF header", async () => {
    response = { available: true, items: [{ id: "skill-a", name: "Analyse", enabled: true, actions: ["disable"] }] };
    render(<OperationsPage section="manage" host="hikari" />);
    fireEvent.click(await screen.findByRole("button", { name: "Deaktivieren" }));
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(calls.some(c => c.init?.method === "POST")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Deaktivieren" }));
    fireEvent.click(screen.getByRole("button", { name: "Bestätigen" }));
    await waitFor(() => expect(calls.some(c => c.init?.method === "POST")).toBe(true));
    const call = calls.find(c => c.init?.method === "POST")!;
    expect(call.url).toBe("/bff/h/hikari/_manage/default/skills/disable");
    expect(call.init?.credentials).toBe("same-origin");
    expect(new Headers(call.init?.headers).get("X-Requested-With")).toBe("hermes-webui");
    expect(JSON.parse(call.init?.body as string)).toEqual({ id: "skill-a" });
  });
  it("lists jobs and only supports advertised actions, never starts a job", async () => {
    response = { available: true, jobs: [{ id: "j1", name: "Sicherung", schedule: "0 8 * * *", actions: ["pause"] }] };
    render(<OperationsPage section="jobs" host="hikari" />);
    expect(await screen.findByText("Sicherung")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pausieren" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Starten" })).not.toBeInTheDocument();
  });
  it("edits only supported job schedule after confirmation", async () => {
    response = { jobs: [{ id: "j1", name: "Sicherung", schedule: "0 8 * * *", actions: ["edit"] }] };
    render(<OperationsPage section="jobs" host="hikari" />);
    fireEvent.change(await screen.findByLabelText("Zeitplan für Sicherung"), { target: { value: "0 9 * * *" } });
    fireEvent.click(screen.getByRole("button", { name: "Zeitplan speichern" }));
    fireEvent.click(screen.getByRole("button", { name: "Bestätigen" }));
    await waitFor(() => expect(calls.some(c => c.init?.method === "PATCH")).toBe(true));
    expect(JSON.parse(calls.find(c => c.init?.method === "PATCH")!.init!.body as string)).toEqual({ schedule: "0 9 * * *" });
  });
  it("renders only explicitly redacted logs as plain bounded text", async () => {
    response = { available: true, redacted: true, content: "<script>not HTML</script>\n" + "a".repeat(70000), truncated: true };
    const { container } = render(<OperationsPage section="logs" host="hikari" />);
    await screen.findByText(/Ausgabe gekürzt/);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("pre")!.textContent!.length).toBeLessThanOrEqual(65536);
  });
  it("refuses logs explicitly marked unredacted", async () => {
    response = { redacted: false, content: "secret-not-for-browser" };
    render(<OperationsPage section="logs" host="hikari" />);
    await screen.findByText(/Redaktion nicht bestätigt/);
    expect(screen.queryByText("secret-not-for-browser")).not.toBeInTheDocument();
  });
  it("searches on submit and links actual session identifiers safely", async () => {
    response = { results: [{ host: "hikari", profile: "default", session_id: "s/1", title: "Fund", snippet: "<b>Inhalt</b>" }], warnings: [{ host: "laptop", reason: "Laptop offline" }], truncated: true };
    render(<OperationsPage section="search" />);
    expect(calls).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Sitzungsinhalte durchsuchen"), { target: { value: "Inhalt" } });
    fireEvent.submit(screen.getByRole("search"));
    expect(await screen.findByRole("link", { name: "Fund" })).toHaveAttribute("href", "/h/hikari/hermes/default/chat/s%2F1");
    expect(screen.getByText("Laptop offline")).toBeInTheDocument();
  });
  it("does not offer installation for unreviewed marketplace entries", async () => {
    const sources = [{ id: "untrusted", label: "Ungeprüft", url: "javascript:alert(1)", reviewed: false, actions: ["install"] }];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...catalog, sources }))));
    render(<OperationsPage section="marketplaces" host="hikari" />);
    await screen.findByText("Ungeprüft");
    expect(screen.queryByRole("button", { name: "Installieren" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
  it("does not silently accept an unknown response shape", async () => {
    response = { surprise: true };
    render(<OperationsPage section="jobs" host="hikari" />);
    await screen.findByText(/Antwortformat nicht unterstützt/);
  });
});
