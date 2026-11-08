import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KanbanSettingsPanel } from "./KanbanSettingsPanel";
import { HomeChannels } from "./kanban/HomeChannels";

type Call = { method: string; url: string; body?: unknown };
let calls: Call[];
let stepUp: boolean;
let homes: { platform: string; name: string; subscribed: boolean }[];
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const settings = {
  config: { default_tenant: "", lane_by_profile: true, include_archived_by_default: false, render_markdown: true },
  orchestration: { orchestrator_profile: "", default_assignee: "", auto_decompose: true, auto_promote_children: true, resolved_orchestrator_profile: "default", resolved_default_assignee: "default", active_profile: "default" },
  columns: [{ key: "todo", label: "To do" }, { key: "done", label: "Fertig" }],
  profiles: [{ name: "default", is_default: true, model: "", provider: "", description: "Allrounder", description_auto: false, skill_count: 3 }, { name: "beta", is_default: false, model: "", provider: "", description: "", description_auto: false, skill_count: 0 }],
  notes: {},
};

beforeEach(() => {
  calls = []; stepUp = false; homes = [{ platform: "telegram", name: "Marc privat", subscribed: false }];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url.endsWith("/_kanban/settings")) return json(settings);
    if (method !== "GET" && stepUp) return json({ detail: { code: "step_up_required", message: "Bitte erneut anmelden" } }, 401);
    if (url.endsWith("/_kanban/orchestration")) return json({ ...settings.orchestration, ...(body as object) });
    if (url.includes("/profiles/beta/describe-auto")) return json({ ok: true, reason: null, description: "Automatisch beschrieben" });
    if (url.includes("/profiles/beta") && method === "PATCH") return json({ ok: true, description: (body as { description: string }).description });
    if (url.includes("/home-channels")) return json({ home_channels: homes });
    if (url.includes("/home-subscribe/")) { homes = homes.map((h) => ({ ...h, subscribed: method === "POST" })); return json({ ok: true }); }
    return json({ detail: "unbekannt" }, 404);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const sent = (method: string, suffix: string) => calls.filter((c) => c.method === method && c.url.includes(suffix));

async function openPanel() {
  const { container } = render(<KanbanSettingsPanel host="server" />);
  const d = container.querySelector("details")!;
  d.open = true; fireEvent(d, new Event("toggle"));
  await screen.findByRole("region", { name: "Orchestrierung" });
}

describe("Kanban-Einstellungen", () => {
  it("loads lazily, only when opened", async () => {
    render(<KanbanSettingsPanel host="server" />);
    expect(calls).toHaveLength(0);
    await openPanel().catch(() => undefined);
  });

  it("saves one orchestration setting at a time and shows the stored result", async () => {
    await openPanel();
    const box = within(screen.getByRole("region", { name: "Orchestrierung" }));
    fireEvent.click(box.getByLabelText("Aufgaben automatisch zerlegen"));
    await waitFor(() => expect(sent("PUT", "/orchestration")[0].body).toEqual({ auto_decompose: false }));
    await screen.findByText("Orchestrierung gespeichert.");
    fireEvent.change(box.getByLabelText("Orchestrator-Profil"), { target: { value: "beta" } });
    await waitFor(() => expect(sent("PUT", "/orchestration")[1].body).toEqual({ orchestrator_profile: "beta" }));
  });

  it("asks for a fresh login instead of failing silently", async () => {
    await openPanel(); stepUp = true;
    fireEvent.click(within(screen.getByRole("region", { name: "Orchestrierung" })).getByLabelText("Aufgaben automatisch zerlegen"));
    await screen.findByText(/frische Anmeldung/);
  });

  it("edits a profile description and keeps the save button off until the text changed", async () => {
    await openPanel();
    const box = within(screen.getByRole("region", { name: "Profil-Beschreibungen" }));
    const row = within(box.getByText("beta").closest("li")!);
    const save = row.getByRole("button", { name: "Speichern" });
    expect(save).toBeDisabled();
    fireEvent.change(row.getByLabelText(/beta/), { target: { value: "Schreibt Tests" } });
    fireEvent.click(save);
    await screen.findByText("Beschreibung von beta gespeichert.");
    expect(sent("PATCH", "/profiles/beta")[0].body).toEqual({ description: "Schreibt Tests" });
  });

  it("describes automatically only after the token warning is confirmed", async () => {
    await openPanel();
    const row = within(within(screen.getByRole("region", { name: "Profil-Beschreibungen" })).getByText("beta").closest("li")!);
    fireEvent.click(row.getByRole("button", { name: "Automatisch beschreiben …" }));
    expect(sent("POST", "/describe-auto")).toHaveLength(0);
    expect(row.getByText(/verbraucht dabei Tokens/)).toBeInTheDocument();
    fireEvent.click(row.getByRole("button", { name: "Jetzt beschreiben" }));
    await screen.findByText("Beschreibung von beta erzeugt.");
    expect(sent("POST", "/describe-auto")[0].body).toEqual({ confirm: true, overwrite: false });
  });

  it("shows columns and display settings read-only", async () => {
    await openPanel();
    const box = within(screen.getByRole("region", { name: "Anzeige und Spalten" }));
    expect(box.getByText(/To do → Fertig/)).toBeInTheDocument();
    expect(box.queryByRole("checkbox")).toBeNull();
  });

  it("explains missing parts of an older Hermes instead of breaking", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => json({ ...settings, orchestration: null, profiles: null, config: null, columns: null, notes: { orchestration: "Diese Hermes-Version kennt /api/plugins/kanban/orchestration nicht." } }));
    await openPanel();
    expect(screen.getByText(/Diese Hermes-Version kennt \/api\/plugins\/kanban\/orchestration nicht/)).toBeInTheDocument();
  });
});

describe("Heimatkanäle je Aufgabe", () => {
  it("toggles the notification for a task and never shows chat ids", async () => {
    render(<HomeChannels host="server" board="default" id="t_1" />);
    const box = await screen.findByRole("checkbox", { name: /Marc privat \(telegram\)/ });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    await waitFor(() => expect(box).toBeChecked());
    expect(sent("POST", "/tasks/t_1/home-subscribe/telegram?board=default")).toHaveLength(1);
    fireEvent.click(box);
    await waitFor(() => expect(box).not.toBeChecked());
    expect(sent("DELETE", "/home-subscribe/telegram")).toHaveLength(1);
  });

  it("stays invisible when no home channel is set up", async () => {
    homes = [];
    const { container } = render(<HomeChannels host="server" id="t_1" />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(container).toBeEmptyDOMElement();
  });
});
