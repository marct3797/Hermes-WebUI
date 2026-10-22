import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Item } from "../../types";
import { ApprovalCard, ReasoningCard, SubagentCard, ToolRow, groupTurns, steps } from "./Convo";

type Approval = Extract<Item, { kind: "approval" }>;
const approval = (over: Partial<Approval> = {}): Approval => ({
  kind: "approval", id: "ap1", command: "rm -r build", reason: "", timeoutS: 300, choices: ["once", "session", "always", "deny"], smartDenied: false, at: Date.now(), ...over,
});

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("groupTurns", () => {
  it("puts everything between user messages into one agent card", () => {
    const user = (id: string): Item => ({ kind: "message", id, role: "user", text: id, reasoning: "", streaming: false, images: [] });
    const agent = (id: string): Item => ({ kind: "message", id, role: "assistant", text: id, reasoning: "", streaming: false, images: [] });
    const tool: Item = { kind: "tool", id: "t", name: "terminal", preview: "ls", status: "ok" };
    const turns = groupTurns([agent("a0"), user("u1"), agent("a1"), tool, agent("a2"), user("u2")]);
    expect(turns.map((t) => t.kind)).toEqual(["agent", "user", "agent", "user"]);
    expect(turns[2].kind === "agent" && turns[2].items.map((i) => i.id)).toEqual(["a1", "t", "a2"]);
  });
});

describe("reasoning", () => {
  it("splits paragraphs, or lines when there are no blank lines", () => {
    expect(steps("eins\n\nzwei\n\n\ndrei")).toEqual(["eins", "zwei", "drei"]);
    expect(steps("eins\nzwei")).toEqual(["eins", "zwei"]);
    expect(steps("nur eins")).toEqual(["nur eins"]);
  });

  it("is a collapsible card with numbered steps", () => {
    render(<ReasoningCard text={"Erst lesen\n\nDann ändern"} defaultOpen={false} />);
    const head = screen.getByRole("button", { name: /Denkprozess/ });
    expect(head).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Erst lesen")).toBeNull();
    fireEvent.click(head);
    expect(screen.getByText("Erst lesen")).toBeInTheDocument();
    expect(screen.getByText("02")).toBeInTheDocument();
    expect(screen.getByText("2 Schritte")).toBeInTheDocument();
  });
});

describe("tool row", () => {
  it("shows name, first preview line, duration and result; opens the output on demand", () => {
    const tool: Item = { kind: "tool", id: "t1", name: "terminal", preview: "pytest -q\nweitere Zeile", status: "ok", durationMs: 3200, output: "12 passed" };
    const onPick = vi.fn();
    const { rerender } = render(<ToolRow t={tool as Extract<Item, { kind: "tool" }>} selected={false} open={false} onPick={onPick} />);
    const row = screen.getByRole("button", { name: /terminal/ });
    expect(row).toHaveTextContent("pytest -q");
    expect(row).not.toHaveTextContent("weitere Zeile");
    expect(row).toHaveTextContent("3,2 s");
    expect(screen.getByRole("img", { name: "fertig" })).toBeInTheDocument();
    fireEvent.click(row);
    expect(onPick).toHaveBeenCalled();
    expect(screen.queryByText("12 passed")).toBeNull();
    rerender(<ToolRow t={tool as Extract<Item, { kind: "tool" }>} selected open onPick={onPick} />);
    expect(screen.getByText("12 passed")).toBeInTheDocument();
  });
});

describe("subagent", () => {
  it("marks a running subagent and lists the values that were reported", () => {
    render(<SubagentCard s={{ kind: "subagent", id: "w", title: "Tests schreiben", status: "running", meta: ["mock-small", "2,4k ein · 310 aus"] }} />);
    expect(screen.getByRole("group", { name: "Subagent: Tests schreiben" })).toHaveTextContent("LÄUFT");
    expect(screen.getByText("mock-small")).toBeInTheDocument();
  });
});

describe("approval card", () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it("offers exactly the choices the agent allows and reports the pick", () => {
    const onDecide = vi.fn();
    render(<ApprovalCard a={approval({ choices: ["once", "deny"], smartDenied: true })} disabled={false} onDecide={onDecide} />);
    expect(screen.queryByRole("button", { name: /Für Session/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Immer/ })).toBeNull();
    expect(screen.getByText(/automatische Prüfung/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Einmal erlauben" }));
    expect(onDecide).toHaveBeenCalledWith("once");
  });

  it("counts down the five minutes and disables the buttons when the request has expired", () => {
    render(<ApprovalCard a={approval({ at: Date.now() })} disabled={false} onDecide={vi.fn()} />);
    expect(screen.getByText("erlischt in 5:00")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(61_000); });
    expect(screen.getByText("erlischt in 3:59")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(240_000); });
    expect(screen.getByText("abgelaufen")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Einmal erlauben" })).toBeDisabled();
  });

  it("collapses to a one-line record once decided", () => {
    render(<ApprovalCard a={approval({ decision: "deny", decidedAt: Date.now() })} disabled={false} onDecide={vi.fn()} />);
    expect(screen.getByRole("group", { name: "Freigabe entschieden" })).toHaveTextContent("Abgelehnt");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
