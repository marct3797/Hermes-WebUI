import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KanbanPage } from "./KanbanPage";

vi.mock("../hosts", () => ({ useHosts: () => ({ hosts: [{ id: "server", label: "Server", runtimes: [] }, { id: "laptop", label: "Laptop", runtimes: [] }] }) }));

const card = (id: string, title: string, status: string, assignee: string | null, extra: object = {}) => ({
  id, title, status, assignee, priority: 0, created_at: 1, completed_at: null, age_seconds: 7200, comment_count: 0, link_counts: { parents: 0, children: 0 },
  warnings: { count: 0, highest_severity: null }, block_kind: null, snippet: `Text zu ${title}`, ...extra,
});
const NAMES = ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done"];
type Call = { method: string; url: string; body?: unknown };
let calls: Call[];
let tasks: ReturnType<typeof card>[];
let fail: Record<string, { status: number; detail: string }>;
let boards: { slug: string; name: string; description: string; color: string; total: number; counts: Record<string, number>; is_current: boolean; archived: boolean; icon: string }[];
const detail = (id: string) => {
  const t = tasks.find((x) => x.id === id)!;
  return { task: { ...t, body: `Beschreibung ${t.title}`, created_by: "user", started_at: null, result: null, summary: null, consecutive_failures: 0, last_failure_error: null },
    comments: [{ id: 1, author: "gamma", body: "Erster Kommentar", created_at: 1_790_000_000 }], events: [{ id: 1, kind: "created", created_at: 1_790_000_000, run_id: null }],
    runs: [{ id: 7, profile: "gamma", status: "blocked", outcome: "blocked", started_at: 1_790_000_000, ended_at: null, summary: "Lauf beendet", error: null }],
    links: { parents: [], children: [] }, link_tasks: [], diagnostics: t.warnings.count ? [{ kind: "stuck_in_blocked", severity: "warning", title: "Aufgabe blockiert", detail: "Wartet" }] : [] };
};

beforeEach(() => {
  calls = [];
  fail = {};
  boards = [
    { slug: "default", name: "Default", description: "", color: "", total: 4, counts: {}, is_current: true, archived: false, icon: "" },
    { slug: "alpha", name: "Alpha", description: "", color: "", total: 0, counts: {}, is_current: false, archived: false, icon: "" },
  ];
  tasks = [card("t_1", "Recherche Marken", "done", "alpha"), card("t_2", "Freigabe prüfen", "blocked", "gamma", { warnings: { count: 1, highest_severity: "warning" }, comment_count: 2, priority: 3 }),
    card("t_3", "Bericht schreiben", "ready", "beta"), card("t_4", "Ohne Besitzer", "todo", null)];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://x");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const method = init?.method ?? "GET";
    calls.push({ method, url: u.pathname.replace("/bff/h/server/_kanban", "") + u.search, body });
    const route = `${method} ${u.pathname.replace("/bff/h/server/_kanban", "").replace(/t_\d/, ":id")}`;
    const f = fail[route];
    if (f) return new Response(JSON.stringify({ detail: f.detail }), { status: f.status });
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    const slug = u.searchParams.get("board") ?? "default";
    switch (route) {
      case "GET /boards": return ok({ boards, current: "default" });
      case "GET /board": return ok({ columns: NAMES.map((n) => ({ name: n, tasks: slug === "alpha" ? [] : tasks.filter((t) => t.status === n) })),
        assignees: ["alpha", "beta", "gamma", "delta", "default", "epsilon", "zeta", "eta"].map((name) => ({ name, counts: slug === "alpha" ? {} : { all: tasks.filter((t) => t.assignee === name).length } })),
        stats: { by_status: { done: 1, blocked: 1, ready: 1, todo: 1 }, oldest_ready_age_seconds: 120 } });
      case "PATCH /tasks/:id": { const t = tasks.find((x) => x.id === u.pathname.split("/").pop())!; if (body.status) t.status = body.status; if (body.title) t.title = body.title; return ok({ ok: true }); }
      case "GET /tasks/:id": return ok(detail(u.pathname.split("/").pop()!));
      case "POST /tasks": { tasks.push(card("t_9", body.title, body.status, body.assignee || null)); return ok({ id: "t_9", warning: null }); }
      case "POST /boards": boards.push({ slug: body.slug, name: body.name, description: "", color: "", total: 0, counts: {}, is_current: false, archived: false, icon: "" }); return ok({ board: boards.at(-1) });
      case "POST /tasks/bulk": tasks = tasks.filter((t) => !body.ids.includes(t.id)); return ok({ results: body.ids.map((id: string) => ({ id, ok: true, error: null })) });
      default: return ok({ ok: true, content: "Zeile 1\nZeile 2", exists: true, truncated: true, size_bytes: 10 });
    }
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const board = async () => { render(<KanbanPage host="server" />); await screen.findByText("Recherche Marken"); };
const col = (name: string) => screen.getByRole("region", { name: `Spalte ${name}` });
const writes = () => calls.filter((c) => c.method !== "GET").map((c) => ({ ...c, url: c.url.replace("?board=default", "") }));

describe("Kanban Board", () => {
  it("zeigt Board-Auswahl mit Anzahl, alle Assignees als Filter und die Spalten mit Zahlen", async () => {
    await board();
    expect(screen.getByRole("combobox", { name: "Board" })).toHaveDisplayValue("Default (4)");
    expect(screen.getByRole("option", { name: "Alpha (0)" })).toBeInTheDocument();
    const chips = within(screen.getByRole("group", { name: "Zugewiesen an" }));
    expect(chips.getAllByRole("button").length).toBe(1 + 8 + 1); // Alle, 8 Assignees, Ohne Zuweisung
    expect(chips.getByRole("button", { name: /^gamma \(1\)/ })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /Profil/ })).not.toBeInTheDocument();
    expect(within(col("Blockiert")).getByTestId("count")).toHaveTextContent("1");
    expect(screen.getByLabelText("1 Warnung")).toBeInTheDocument();
    expect(screen.getByLabelText("Kurzstatistik")).toHaveTextContent("4 Aufgaben · 1 blockiert");
  });

  const LABELS = ["Einordnung", "Offen", "Geplant", "Bereit", "Läuft", "Blockiert", "Prüfung", "Erledigt"];
  const columnLabels = () => screen.getAllByRole("region", { name: /^Spalte / }).map((el) => el.getAttribute("aria-label")!.replace("Spalte ", ""));

  it("zeigt alle Statusspalten in fester Reihenfolge in einer einzigen Reihe, leere inklusive", async () => {
    await board();
    expect(columnLabels()).toEqual(LABELS);
    const parents = new Set(screen.getAllByRole("region", { name: /^Spalte / }).map((el) => el.parentElement));
    expect(parents.size).toBe(1); // ein gemeinsamer Container: kein Umbruch in eine zweite Gruppe
    expect(col("Erledigt").parentElement).toBe(col("Einordnung").parentElement);
    expect(document.querySelector(".kb-empty-columns")).toBeNull();
  });

  it("behält Reihenfolge und leere Spalten bei Filter und Verschieben", async () => {
    await board();
    fireEvent.click(screen.getByRole("button", { name: /^gamma/ }));
    expect(columnLabels()).toEqual(LABELS);
    fireEvent.click(screen.getByRole("button", { name: /^Alle/ }));
    const el = screen.getByText("Bericht schreiben").closest("li")!;
    fireEvent.dragStart(el);
    fireEvent.drop(col("Erledigt"));
    await waitFor(() => expect(within(col("Erledigt")).getByText("Bericht schreiben")).toBeInTheDocument());
    expect(columnLabels()).toEqual(LABELS);
  });

  it("zeigt auch ein leeres Board mit allen Spalten", async () => {
    await board();
    fireEvent.change(screen.getByRole("combobox", { name: "Board" }), { target: { value: "alpha" } });
    expect(await screen.findByText("Keine Aufgaben, lege die erste an.")).toBeInTheDocument();
    expect(columnLabels()).toEqual(LABELS);
  });

  it("wechselt das Board und zeigt das leere Board ehrlich", async () => {
    await board();
    fireEvent.change(screen.getByRole("combobox", { name: "Board" }), { target: { value: "alpha" } });
    expect(await screen.findByText("Keine Aufgaben, lege die erste an.")).toBeInTheDocument();
    expect(calls.some((c) => c.url.startsWith("/board?board=alpha"))).toBe(true);
  });

  it("filtert nach Assignee und Suche", async () => {
    await board();
    fireEvent.click(screen.getByRole("button", { name: /^gamma/ }));
    expect(screen.queryByText("Recherche Marken")).not.toBeInTheDocument();
    expect(screen.getByText("Freigabe prüfen")).toBeInTheDocument();
    expect(within(col("Blockiert")).getByTestId("count")).toHaveTextContent("1 von 1");
    fireEvent.click(screen.getByRole("button", { name: /^Alle/ }));
    fireEvent.click(screen.getByRole("button", { name: /Ohne Zuweisung/ }));
    expect(screen.getByText("Ohne Besitzer")).toBeInTheDocument();
    expect(screen.queryByText("Bericht schreiben")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Alle/ }));
    fireEvent.change(screen.getByLabelText("Aufgaben suchen"), { target: { value: "t_3" } });
    expect(screen.getByText("Bericht schreiben")).toBeInTheDocument();
    expect(screen.queryByText("Ohne Besitzer")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Aufgaben suchen"), { target: { value: "zzz" } });
    expect(within(col("Bereit")).getByText("Nichts passt zum Filter")).toBeInTheDocument();
  });

  it("verschiebt per Drag and Drop und speichert den Status", async () => {
    await board();
    const el = screen.getByText("Bericht schreiben").closest("li")!;
    fireEvent.dragStart(el);
    fireEvent.dragOver(col("Prüfung"));
    fireEvent.drop(col("Prüfung"));
    await waitFor(() => expect(within(col("Prüfung")).getByText("Bericht schreiben")).toBeInTheDocument());
    expect(writes()).toEqual([{ method: "PATCH", url: "/tasks/t_3", body: { status: "review" } }]);
  });

  it("macht das Verschieben bei Fehler rückgängig und nennt den Grund", async () => {
    fail["PATCH /tasks/:id"] = { status: 502, detail: "Das Dashboard meldet Fehler 409: blockiert durch Eltern" };
    await board();
    const el = screen.getByText("Bericht schreiben").closest("li")!;
    fireEvent.dragStart(el);
    fireEvent.drop(col("Erledigt"));
    expect(await screen.findByRole("alert")).toHaveTextContent("blockiert durch Eltern");
    expect(within(col("Bereit")).getByText("Bericht schreiben")).toBeInTheDocument();
    expect(within(col("Erledigt")).queryByText("Bericht schreiben")).not.toBeInTheDocument();
  });

  it("erlaubt kein Ablegen in der Spalte Läuft", async () => {
    await board();
    fireEvent.dragStart(screen.getByText("Bericht schreiben").closest("li")!);
    fireEvent.drop(col("Läuft"));
    expect(writes()).toEqual([]);
    expect(screen.getByRole("combobox", { name: "Bericht schreiben verschieben nach" }).innerHTML).not.toContain("Läuft");
  });

  it("verschiebt per Menü", async () => {
    await board();
    fireEvent.change(screen.getByRole("combobox", { name: "Ohne Besitzer verschieben nach" }), { target: { value: "ready" } });
    await waitFor(() => expect(within(col("Bereit")).getByText("Ohne Besitzer")).toBeInTheDocument());
    expect(writes()[0]).toEqual({ method: "PATCH", url: "/tasks/t_4", body: { status: "ready" } });
  });

  it("zeigt lange Spalten gekürzt und lädt mehr", async () => {
    tasks = Array.from({ length: 35 }, (_, i) => card(`t_${i}`.replace("t_", "t_"), `Erledigt ${i}`, "done", "alpha"));
    render(<KanbanPage host="server" />);
    await screen.findByText("Erledigt 0");
    expect(within(col("Erledigt")).getAllByRole("listitem").length).toBe(30);
    fireEvent.click(screen.getByRole("button", { name: /Mehr laden \(5 weitere\)/ }));
    expect(within(col("Erledigt")).getAllByRole("listitem").length).toBe(35);
  });

  it("zeigt Fehler und fehlendes Dashboard mit Grund", async () => {
    fail["GET /boards"] = { status: 503, detail: "Für diesen Host ist kein Dashboard eingerichtet" };
    render(<KanbanPage host="server" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Kanban nicht ladbar: Für diesen Host ist kein Dashboard eingerichtet");
  });
});

describe("Kanban Detail und Anlegen", () => {
  it("öffnet eine Karte, bearbeitet Titel und Text und speichert nur Geändertes", async () => {
    await board();
    fireEvent.click(screen.getByRole("button", { name: "Aufgabe öffnen: Freigabe prüfen" }));
    const panel = within(await screen.findByRole("complementary", { name: "Aufgabendetail" }));
    await panel.findByText("Erster Kommentar");
    expect(panel.getByText("Aufgabe blockiert")).toBeInTheDocument();
    expect(panel.getByRole("button", { name: "Speichern" })).toBeDisabled();
    fireEvent.change(panel.getByLabelText("Titel"), { target: { value: "Freigabe prüfen v2" } });
    fireEvent.change(panel.getByLabelText("Text"), { target: { value: "# Neu" } });
    fireEvent.click(panel.getByRole("tab", { name: "Vorschau" }));
    expect(panel.getByRole("heading", { name: "Neu" })).toBeInTheDocument();
    fireEvent.click(panel.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(writes()).toEqual([{ method: "PATCH", url: "/tasks/t_2", body: { title: "Freigabe prüfen v2", body: "# Neu" } }]));
    expect(await panel.findByText("Gespeichert")).toBeInTheDocument();
  });

  it("zeigt Fehler beim Speichern und behält die Eingabe", async () => {
    fail["PATCH /tasks/:id"] = { status: 502, detail: "Das Dashboard meldet Fehler 400: title cannot be empty" };
    await board();
    fireEvent.click(screen.getByRole("button", { name: "Aufgabe öffnen: Freigabe prüfen" }));
    const panel = within(await screen.findByRole("complementary", { name: "Aufgabendetail" }));
    await panel.findByText("Erster Kommentar");
    fireEvent.change(panel.getByLabelText("Titel"), { target: { value: "Neu" } });
    fireEvent.click(panel.getByRole("button", { name: "Speichern" }));
    expect(await panel.findByRole("alert")).toHaveTextContent("title cannot be empty");
    expect(panel.getByLabelText("Titel")).toHaveValue("Neu");
  });

  it("sendet einen Kommentar, weist neu zu und lädt das Log nach", async () => {
    await board();
    fireEvent.click(screen.getByRole("button", { name: "Aufgabe öffnen: Freigabe prüfen" }));
    const panel = within(await screen.findByRole("complementary", { name: "Aufgabendetail" }));
    await panel.findByText("Erster Kommentar");
    fireEvent.change(panel.getByLabelText("Neuer Kommentar"), { target: { value: "Weiter geht es" } });
    fireEvent.click(panel.getByRole("button", { name: "Kommentar senden" }));
    await waitFor(() => expect(writes()).toContainEqual({ method: "POST", url: "/tasks/t_2/comments", body: { body: "Weiter geht es" } }));
    await waitFor(() => expect(panel.getByLabelText("Neuer Kommentar")).toHaveValue(""));
    fireEvent.change(panel.getByRole("combobox", { name: "Zugewiesen an" }), { target: { value: "beta" } });
    fireEvent.click(panel.getByRole("button", { name: "Neu zuweisen" }));
    await waitFor(() => expect(writes()).toContainEqual({ method: "POST", url: "/tasks/t_2/reassign", body: { assignee: "beta", reclaim_first: false } }));
    fireEvent.click(panel.getByRole("button", { name: "Log laden" }));
    expect(await panel.findByLabelText("Log")).toHaveTextContent("Zeile 1");
    expect(calls.some((c) => c.url.includes("/log") && c.url.includes("tail=20000"))).toBe(true);
    expect(panel.getByRole("button", { name: "Mehr Log laden" })).toBeInTheDocument();
  });

  it("legt Verknüpfungen an", async () => {
    await board();
    fireEvent.click(screen.getByRole("button", { name: "Aufgabe öffnen: Freigabe prüfen" }));
    const panel = within(await screen.findByRole("complementary", { name: "Aufgabendetail" }));
    await panel.findByText("Erster Kommentar");
    fireEvent.change(panel.getByRole("combobox", { name: "Andere Aufgabe" }), { target: { value: "t_3" } });
    fireEvent.click(panel.getByRole("button", { name: "Verknüpfen" }));
    await waitFor(() => expect(writes()).toContainEqual({ method: "POST", url: "/links", body: { parent_id: "t_3", child_id: "t_2" } }));
  });

  it("archiviert erst nach Bestätigung im Dialog", async () => {
    await board();
    fireEvent.click(screen.getByRole("button", { name: "Aufgabe öffnen: Ohne Besitzer" }));
    const panel = within(await screen.findByRole("complementary", { name: "Aufgabendetail" }));
    await panel.findByText("Erster Kommentar");
    fireEvent.click(panel.getByRole("button", { name: "Archivieren" }));
    expect(writes()).toEqual([]);
    const dlg = within(screen.getByRole("dialog", { name: "Aufgabe archivieren" }));
    fireEvent.click(dlg.getByRole("button", { name: "Abbrechen" }));
    expect(writes()).toEqual([]);
    fireEvent.click(panel.getByRole("button", { name: "Archivieren" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Aufgabe archivieren" })).getByRole("button", { name: "Archivieren" }));
    await waitFor(() => expect(writes()).toEqual([{ method: "POST", url: "/tasks/bulk", body: { ids: ["t_4"], archive: true } }]));
    await waitFor(() => expect(screen.queryByText("Ohne Besitzer")).not.toBeInTheDocument());
  });

  it("legt eine Aufgabe an und öffnet sie", async () => {
    await board();
    fireEvent.click(screen.getByRole("button", { name: "Neue Aufgabe" }));
    const dlg = within(screen.getByRole("dialog", { name: "Neue Aufgabe" }));
    expect(dlg.getByRole("button", { name: "Aufgabe anlegen" })).toBeDisabled();
    fireEvent.change(dlg.getByLabelText(/Titel/), { target: { value: "Neu angelegt" } });
    fireEvent.change(dlg.getByLabelText("Zugewiesen an"), { target: { value: "beta" } });
    fireEvent.change(dlg.getByLabelText("Status"), { target: { value: "todo" } });
    fireEvent.click(dlg.getByRole("button", { name: "Aufgabe anlegen" }));
    await waitFor(() => expect(writes()[0]).toEqual({ method: "POST", url: "/tasks", body: { title: "Neu angelegt", body: "", assignee: "beta", priority: 0, status: "todo", parents: [] } }));
    expect(await within(await screen.findByRole("region", { name: "Spalte Offen" })).findByText("Neu angelegt")).toBeInTheDocument();
  });

  it("legt ein Board an und wechselt darauf", async () => {
    await board();
    fireEvent.click(screen.getByRole("button", { name: "Neues Board" }));
    const dlg = within(screen.getByRole("dialog", { name: "Neues Board" }));
    fireEvent.change(dlg.getByLabelText(/Name/), { target: { value: "Mein Böard" } });
    expect(dlg.getByLabelText(/Kennung/)).toHaveValue("mein-board");
    fireEvent.click(dlg.getByRole("button", { name: "Board anlegen" }));
    await waitFor(() => expect(writes()[0]).toEqual({ method: "POST", url: "/boards", body: { slug: "mein-board", name: "Mein Böard" } }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Board" })).toHaveDisplayValue("Mein Böard (0)"));
  });
});
