import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NO_RUN, ShellContext } from "../../shell";
import type { SessionSummary } from "../../types";
import { SessionColumn } from "./SessionColumn";

afterEach(cleanup);

const now = Date.now();
const SESSIONS: SessionSummary[] = [
  { id: "a", title: "Tests prüfen", updatedAt: now, messageCount: 8 },
  { id: "b", title: "Adapter lesen", updatedAt: now - 3_000, pinned: true },
  { id: "c", title: "Gestern erledigt", updatedAt: now - 30 * 3_600_000 },
  { id: "d", title: "Nightly Lint", updatedAt: now, source: "cron" },
];

function mount(sessionId?: string, run = NO_RUN) {
  render(
    <ShellContext.Provider value={{ openMenu: () => undefined, sessions: SESSIONS, sessionsLoading: false, refreshSessions: () => undefined, run, setRun: () => undefined }}>
      <SessionColumn agent={{ host: "hikari", runtime: "hermes", agent: "raiden" }} label="raiden" runtimeLabel="Hermes" sessionId={sessionId} />
    </ShellContext.Provider>,
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

  it("shows the run state on the open session only", () => {
    mount("a", { status: "running", waiting: true });
    const open = screen.getByRole("link", { name: /Tests prüfen/ });
    expect(open).toHaveAttribute("aria-current", "page");
    expect(open).toHaveTextContent("wartet");
    expect(screen.getByRole("link", { name: /Adapter lesen/ })).not.toHaveTextContent("wartet");
  });

  it("focuses the search with the slash key", () => {
    mount();
    fireEvent.keyDown(document.body, { key: "/" });
    expect(screen.getByRole("textbox", { name: "Sessions durchsuchen" })).toHaveFocus();
  });
});
