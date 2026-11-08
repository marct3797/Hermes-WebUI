import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KanbanPage } from "./KanbanPage";

vi.mock("../hosts", () => ({ useHosts: () => ({ hosts: [{ id: "server", label: "Server", runtimes: [] }] }) }));

const issue = (number: number, title: string, column: string, extra: object = {}) => ({
  repo: "o/r", number, title, state: column === "closed" ? "closed" : "open", column, assignee: null, assignees: [], labels: [], comments: 0, created_at: "2026-11-01T10:00:00Z",
  updated_at: null, url: `https://git.test/o/r/issues/${number}`, author: "marc", snippet: `Text ${title}`, ...extra,
});
type Call = { method: string; path: string; body?: any };
let calls: Call[];
let issues: ReturnType<typeof issue>[];
let instances: object[];

beforeEach(() => {
  calls = [];
  issues = [issue(1, "Offen", "open"), issue(2, "Läuft", "in-progress", { assignee: "marc", comments: 1 }), issue(3, "Fertig", "closed")];
  instances = [{ id: "fj", label: "Forgejo", base_url: "https://git.test", repos: ["o/r", "o/zwei"], columns: ["open", "in-progress", "closed"], token_set: true }];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://x");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname + u.search, body });
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (u.pathname === "/bff/forgejo") return ok({ instances, config_error: null });
    if (u.pathname.startsWith("/bff/h/server/_kanban")) return ok(u.pathname.endsWith("/boards") ? { boards: [], current: null } : { columns: [], assignees: [], stats: { by_status: {}, oldest_ready_age_seconds: null } });
    const m = /^\/bff\/forgejo\/fj\/issues(?:\/(\d+))?(\/comments)?$/.exec(u.pathname);
    if (!m) return new Response("{}", { status: 404 });
    const n = m[1] ? Number(m[1]) : undefined;
    if (!n && method === "GET") return ok({ issues, truncated: false, columns: ["open", "in-progress", "closed"] });
    const it = issues.find((i) => i.number === n)!;
    if (method === "GET") return ok({ ...it, body: `Beschreibung ${it.title}`, comment_list: [{ id: 1, author: "marc", body: "Erster Kommentar", created_at: null }] });
    if (method === "PATCH") { if (body.column) { it.column = body.column; it.state = body.column === "closed" ? "closed" : "open"; } return ok({ ...it, body: "", comment_list: [] }); }
    return ok({ ok: true });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openForgejo() {
  render(<KanbanPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Forgejo-Issues" }));
  await screen.findByText(/#2 Läuft/);
}

describe("Kanban: Forgejo-Issues", () => {
  it("ohne Konfiguration gibt es keinen Reiter", async () => {
    instances = [];
    render(<KanbanPage />);
    await waitFor(() => expect(calls.some((c) => c.path === "/bff/forgejo")).toBe(true));
    expect(screen.queryByRole("button", { name: "Forgejo-Issues" })).toBeNull();
  });

  it("zeigt die Issues in den Spalten und lässt das Hermes-Board unberührt", async () => {
    await openForgejo();
    expect(screen.getByRole("region", { name: "Spalte Offen" })).toHaveTextContent("#1 Offen");
    expect(screen.getByRole("region", { name: "Spalte in-progress" })).toHaveTextContent("#2 Läuft");
    expect(screen.getByRole("region", { name: "Spalte Geschlossen" })).toHaveTextContent("#3 Fertig");
    expect(calls.some((c) => c.path.includes("repo=o%2Fr"))).toBe(true);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("Verschieben schreibt die Spalte ans Issue", async () => {
    await openForgejo();
    fireEvent.change(screen.getByLabelText("#1 Offen verschieben nach"), { target: { value: "in-progress" } });
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ column: "in-progress" }));
    expect(calls.find((c) => c.method === "PATCH")?.path).toBe("/bff/forgejo/fj/issues/1?repo=o%2Fr");
  });

  it("Repo wechseln lädt neu; Detail zeigt Kommentare und sendet einen neuen", async () => {
    await openForgejo();
    fireEvent.change(screen.getByLabelText("Repo"), { target: { value: "o/zwei" } });
    await waitFor(() => expect(calls.some((c) => c.path.includes("repo=o%2Fzwei"))).toBe(true));
    fireEvent.click(await screen.findByRole("button", { name: /Aufgabe öffnen: #2 Läuft/ }));
    await screen.findByText("Erster Kommentar");
    fireEvent.change(screen.getByLabelText("Kommentar"), { target: { value: "Neu" } });
    fireEvent.click(screen.getByRole("button", { name: "Kommentar senden" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ body: "Neu" }));
  });

  it("fehlender Token wird erklärt", async () => {
    instances = [{ ...(instances[0] as object), token_set: false }];
    await openForgejo();
    expect(screen.getByText(/Forgejo-Token fehlt/)).toBeInTheDocument();
  });
});
