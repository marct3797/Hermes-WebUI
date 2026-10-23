import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { act } from "@testing-library/react";
import { vi } from "vitest";
import { RunsProvider } from "../../runs";
import { createRunStore } from "../../runStore";
import { ShellContext } from "../../shell";
import type { AgentRef, SessionSummary, StreamEvent } from "../../types";
import { SessionColumn } from "./SessionColumn";

afterEach(cleanup);

const now = Date.now();
const SESSIONS: SessionSummary[] = [
  { id: "a", title: "Tests prüfen", updatedAt: now, messageCount: 8 },
  { id: "b", title: "Adapter lesen", updatedAt: now - 3_000, pinned: true },
  { id: "c", title: "Gestern erledigt", updatedAt: now - 30 * 3_600_000 },
  { id: "d", title: "Nightly Lint", updatedAt: now, source: "cron" },
];

const AGENT: AgentRef = { host: "hikari", runtime: "hermes", agent: "raiden" };

/** Ein Run in Session „a“, der auf eine Freigabe wartet. */
async function waitingRun() {
  let es: { onmessage: ((e: MessageEvent) => void) | null } | undefined;
  const api = { startRun: vi.fn(async () => ({ run_id: "r1", session_id: "a" })), eventsUrl: () => "/e", messages: vi.fn(), runStatus: vi.fn() };
  const store = createRunStore({ api: api as never, eventSource: () => (es = { onmessage: null, onerror: null, close: () => undefined } as never) as never });
  await store.send(AGENT, "a", "los", []);
  const emit = (ev: StreamEvent) => act(() => { es!.onmessage?.(new MessageEvent("message", { data: JSON.stringify(ev) })); });
  emit({ type: "approval.requested", command: "ls", reason: "", choices: ["once", "deny"], timeout_s: 300 });
  return store;
}

function mount(sessionId?: string, store = createRunStore()) {
  render(
    <RunsProvider store={store}>
      <ShellContext.Provider value={{ openMenu: () => undefined, sessions: SESSIONS, sessionsLoading: false, refreshSessions: () => undefined }}>
        <SessionColumn agent={AGENT} label="raiden" runtimeLabel="Hermes" sessionId={sessionId} />
      </ShellContext.Provider>
    </RunsProvider>,
  );
}

describe("SessionColumn", () => {
  it("groups chats by day and keeps automation behind its own filter", () => {
    mount();
    const today = screen.getByRole("group", { name: "Heute" });
    expect(within(today).getAllByRole("link").map((l) => l.textContent)).toEqual([expect.stringContaining("Tests prüfen"), expect.stringContaining("Adapter lesen")]);
    expect(screen.getByRole("group", { name: "Gestern" })).toHaveTextContent("Gestern erledigt");
    expect(screen.queryByText("Nightly Lint")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Automation/ }));
    expect(screen.getByText("Nightly Lint")).toBeInTheDocument();
    expect(screen.queryByText("Tests prüfen")).toBeNull();
  });

  it("filters by search text and by pinned", () => {
    mount();
    fireEvent.change(screen.getByRole("textbox", { name: "Sessions durchsuchen" }), { target: { value: "adapter" } });
    expect(screen.getAllByRole("link", { name: /Adapter lesen|Neuer Chat/ }).length).toBe(2);
    expect(screen.queryByText("Tests prüfen")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Sessions durchsuchen" }), { target: { value: "zzz" } });
    expect(screen.getByText("Keine Treffer.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Sessions durchsuchen" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Nur angepinnte" }));
    expect(screen.getByText("Adapter lesen")).toBeInTheDocument();
    expect(screen.queryByText("Tests prüfen")).toBeNull();
  });

  it("shows the run state of each session, also of one that is not open", async () => {
    mount("b", await waitingRun());
    expect(screen.getByRole("link", { name: /Tests prüfen/ })).toHaveTextContent("wartet");
    const open = screen.getByRole("link", { name: /Adapter lesen/ });
    expect(open).toHaveAttribute("aria-current", "page");
    expect(open).not.toHaveTextContent("wartet");
  });

  it("focuses the search with the slash key", () => {
    mount();
    fireEvent.keyDown(document.body, { key: "/" });
    expect(screen.getByRole("textbox", { name: "Sessions durchsuchen" })).toHaveFocus();
  });
});

describe("SessionColumn: Aktionen und Nachladen", () => {
  function mountWith(extra: Record<string, unknown>) {
    render(
      <RunsProvider store={createRunStore()}>
        <ShellContext.Provider value={{ openMenu: () => undefined, sessions: SESSIONS, sessionsLoading: false, refreshSessions: () => undefined, ...extra }}>
          <SessionColumn agent={AGENT} label="raiden" runtimeLabel="Hermes" sessionId="a" />
        </ShellContext.Provider>
      </RunsProvider>,
    );
  }
  const menu = (title: string) => fireEvent.click(screen.getByRole("button", { name: `Aktionen für ${title}` }));

  it("renames a session in place and sends the trimmed title", async () => {
    const renameSession = vi.fn(async () => undefined);
    mountWith({ renameSession, deleteSession: vi.fn() });
    menu("Adapter lesen");
    fireEvent.click(screen.getByRole("menuitem", { name: /Umbenennen/ }));
    const box = screen.getByRole("textbox", { name: "Neuer Titel" });
    expect(box).toHaveValue("Adapter lesen");
    fireEvent.change(box, { target: { value: "  Adapter prüfen  " } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await vi.waitFor(() => expect(renameSession).toHaveBeenCalledWith("b", "Adapter prüfen"));
    await vi.waitFor(() => expect(screen.queryByRole("textbox", { name: "Neuer Titel" })).toBeNull());
  });

  it("asks before deleting and only then calls delete", async () => {
    const deleteSession = vi.fn(async () => undefined);
    mountWith({ renameSession: vi.fn(), deleteSession });
    menu("Gestern erledigt");
    fireEvent.click(screen.getByRole("menuitem", { name: /Löschen/ }));
    expect(deleteSession).not.toHaveBeenCalled();
    expect(screen.getByText(/wird endgültig gelöscht/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(deleteSession).not.toHaveBeenCalled();
    menu("Gestern erledigt");
    fireEvent.click(screen.getByRole("menuitem", { name: /Löschen/ }));
    fireEvent.click(screen.getByRole("button", { name: "Endgültig löschen" }));
    await vi.waitFor(() => expect(deleteSession).toHaveBeenCalledWith("c"));
  });

  it("shows why an action failed and keeps the menu open", async () => {
    mountWith({ renameSession: vi.fn(async () => { throw new Error("Titel schon vergeben"); }), deleteSession: vi.fn() });
    menu("Adapter lesen");
    fireEvent.click(screen.getByRole("menuitem", { name: /Umbenennen/ }));
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Titel schon vergeben");
  });

  it("offers older sessions only when there are more and hides the button while searching", () => {
    const loadMoreSessions = vi.fn();
    mountWith({ hasMoreSessions: true, loadMoreSessions });
    fireEvent.click(screen.getByRole("button", { name: /Ältere laden \(4 geladen\)/ }));
    expect(loadMoreSessions).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole("textbox", { name: "Sessions durchsuchen" }), { target: { value: "x" } });
    expect(screen.queryByRole("button", { name: /Ältere laden/ })).toBeNull();
  });

  it("shows no action buttons when the shell cannot rename (older shells, tests)", () => {
    mount();
    expect(screen.queryByRole("button", { name: /Aktionen für/ })).toBeNull();
  });
});
