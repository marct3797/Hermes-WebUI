import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { sessionStats } from "../../stats";
import { USAGE_PAGE, type AgentUsage } from "../../useUsage";
import { UsagePanel } from "./UsagePanel";

afterEach(cleanup);

const NOON = new Date(2026, 9, 23, 12, 0, 0).getTime();
const at = (daysAgo: number) => new Date(2026, 9, 23 - daysAgo, 10, 0, 0).getTime() / 1000;
const row = (daysAgo: number, extra: Record<string, unknown> = {}) => ({
  started_at: at(daysAgo), source: "api_server", model: "muse", message_count: 4, tool_call_count: 3, input_tokens: 10_000, output_tokens: 2_000, ...extra,
});

function mount(rows: Record<string, unknown[]>, opts: { rawRows?: number; loading?: boolean } = {}) {
  const byAgent = new Map<string, AgentUsage>();
  const all = Object.entries(rows).flatMap(([agent, list]) => {
    const stats = sessionStats(agent, { data: list });
    byAgent.set(`hikari/hermes/${agent}`, { loaded: true, stats, rows: opts.rawRows ?? list.length });
    return stats;
  });
  render(<UsagePanel stats={all} byAgent={byAgent} loading={opts.loading ?? false} now={NOON} />);
}

describe("Auswertung", () => {
  it("shows tokens, tool calls and sessions of the chosen period", () => {
    mount({ inari: [row(0), row(2), row(20)], raiden: [row(1, { model: "kimi", cache_read_tokens: 30_000 })] });
    const kpis = screen.getByRole("group", { name: /Kennzahlen, letzte 14 Tage/ });
    expect(within(kpis).getByText("Sessions").nextSibling).toHaveTextContent("3"); // die Session von vor 20 Tagen liegt außerhalb
    expect(within(kpis).getByText("36 k")).toBeInTheDocument(); // 3 × 12 000 Tokens
    expect(within(kpis).getByText("Cache-Anteil").nextSibling).toHaveTextContent("50 %"); // 30 000 gelesen bei 30 000 normaler Eingabe
    fireEvent.click(screen.getByRole("button", { name: "30 Tage" }));
    expect(screen.getByRole("group", { name: /letzte 30 Tage/ })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: /letzte 30 Tage/ })).getByText("Sessions").nextSibling).toHaveTextContent("4");
  });

  it("ranks agents and models and hides cost unless Hermes reports one", () => {
    mount({ inari: [row(0), row(0)], raiden: [row(1, { model: "kimi", input_tokens: 90_000 })] });
    const byAgent = screen.getByRole("table", { name: "Nach Agent" });
    expect(within(byAgent).getAllByRole("rowheader").map((h) => h.textContent)).toEqual(["raiden", "inari"]);
    expect(within(screen.getByRole("table", { name: "Nach Modell" })).getAllByRole("rowheader")[0]).toHaveTextContent("kimi");
    expect(screen.queryByText("Kosten")).toBeNull();
  });

  it("shows cost when reported, and says so when nothing happened", () => {
    mount({ inari: [row(0, { estimated_cost_usd: 1.5 })] });
    expect(screen.getByText("Kosten").nextSibling).toHaveTextContent("1,50 $");
    cleanup();
    mount({ inari: [] });
    expect(screen.getByText("Keine Sessions in diesem Zeitraum.")).toBeInTheDocument();
    expect(screen.getByText("Cache-Anteil").nextSibling).toHaveTextContent("–");
  });

  it("warns when the last 100 sessions do not reach back to the start of the period", () => {
    mount({ inari: [row(0), row(3)] }, { rawRows: USAGE_PAGE });
    expect(screen.getByText(/letzten 100 Sessions/)).toBeInTheDocument();
    cleanup();
    mount({ inari: [row(0), row(14)] }, { rawRows: USAGE_PAGE });
    expect(screen.queryByText(/letzten 100 Sessions/)).toBeNull(); // älteste Session liegt vor dem Zeitraum: nichts fehlt
  });

  it("shows a placeholder while loading", () => {
    mount({}, { loading: true });
    expect(screen.getByText("Lade…")).toBeInTheDocument();
  });
});
