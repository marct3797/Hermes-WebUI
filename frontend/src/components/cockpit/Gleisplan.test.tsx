import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Gleisplan } from "./Gleisplan";

const ref = { host: "h", runtime: "hermes", agent: "a" };
const now = Date.UTC(2026, 10, 8, 12, 0, 0);

describe("Gleisplan", () => {
  it("zeigt je Agent eine Zeile und nur Sessions der letzten 24 Stunden", () => {
    const chats = new Map([["h/hermes/a", { loaded: true, times: [now - 3_600_000, now - 90_000_000] }]]);
    const { container } = render(<Gleisplan rows={[{ ref, label: "alpha" }]} chats={chats} live={[]} needs={[]} sigils={{}} now={now} />);
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(container.querySelectorAll(".gp-tick")).toHaveLength(1);
    expect(container.querySelectorAll(".gp-run")).toHaveLength(0);
  });

  it("markiert einen laufenden Run als Balken", () => {
    const live = [{ convKey: "c", agent: ref, startedAt: now - 600_000, waiting: null, activity: "terminal" }];
    const { container } = render(<Gleisplan rows={[{ ref, label: "alpha" }]} chats={new Map()} live={live} needs={[]} sigils={{}} now={now} />);
    expect(container.querySelectorAll(".gp-run")).toHaveLength(1);
  });
});
