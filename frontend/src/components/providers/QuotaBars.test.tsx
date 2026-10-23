import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import { resetRedirect } from "../../api";
import quotaFixture from "../../fixtures/quota_laptop.json";
import { installBackend, type QuotaMode } from "../../test-backend";
import type { Quota } from "../../types";
import { QuotaBars, fmtIn } from "./QuotaBars";

const real = quotaFixture as unknown as Quota;
beforeEach(() => resetRedirect());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const block = (name: string) => within(screen.getByRole("listitem", { name }));

describe("fmtIn", () => {
  it("writes relative times in German units", () => {
    expect([0, 59, 60, 3572, 5700, 7200, 13044, 700_000].map(fmtIn)).toEqual([
      "in weniger als 1 Min", "in weniger als 1 Min", "in 1 Min", "in 59 Min", "in 1 Std 35 Min", "in 2 Std", "in 3 Std 37 Min", "in 8 Tagen 2 Std"]);
  });
});

describe("QuotaBars mit der echten Plugin-Antwort", () => {
  beforeEach(() => { render(<QuotaBars quota={real} />); });

  it("shows Anthropic with exact remaining percent per window and the reset as relative time", () => {
    const a = block("Anthropic");
    expect(a.getByRole("progressbar", { name: "Aktuelle Sitzung: 74 % übrig" })).toHaveAttribute("aria-valuenow", "74");
    expect(a.getByRole("progressbar", { name: "Aktuelle Woche: 73 % übrig" })).toBeInTheDocument();
    expect(a.getByText("in 3 Std 37 Min")).toBeInTheDocument();
    expect(a.queryByText("Erschöpft")).not.toBeInTheDocument();
  });

  it("marks Codex as exhausted with plan, 0 % and the reset, and keeps the healthy weekly window green", () => {
    const c = block("ChatGPT or Codex Subscription");
    expect(c.getByText("Plus")).toBeInTheDocument();
    expect(c.getByText("Erschöpft")).toBeInTheDocument();
    expect(c.getByRole("progressbar", { name: "Sitzung: 0 % übrig" }).querySelector("i")).toHaveClass("q-bad");
    expect(c.getByText("in 59 Min")).toBeInTheDocument();
    expect(c.getByRole("progressbar", { name: "Woche: 84 % übrig" }).querySelector("i")).toHaveClass("q-ok");
  });

  it("marks OpenCode Go as exhausted because of the monthly window, with the provider's detail", () => {
    const g = block("OpenCode Go");
    expect(g.getByText("Erschöpft")).toBeInTheDocument();
    expect(g.getByRole("progressbar", { name: "Monat: 0 % übrig" })).toBeInTheDocument();
    expect(g.getByText("status: rate-limited")).toBeInTheDocument();
    expect(g.getByRole("progressbar", { name: "Rollierend (5 Std): 99 % übrig" })).toBeInTheDocument();
  });

  it("shows Copilot with a date-only reset in the tooltip", () => {
    const c = block("GitHub Copilot");
    expect(c.getByText("individual")).toBeInTheDocument();
    expect(c.getByText("200 of 200 left")).toBeInTheDocument();
    expect(c.getAllByText("in 8 Tagen")[0]).toHaveAttribute("title", "Reset am 01.11.2026");
  });

  it("shows Nous as expired access with the plugin's reason, never as a plain empty block", () => {
    const n = block("Nous Portal");
    expect(n.getByText("Zugang prüfen")).toBeInTheDocument();
    expect(n.getByText(/Not signed in to Nous Portal/)).toBeInTheDocument();
  });

  it("lists providers without an API under 'Nicht abfragbar' with their reason", () => {
    const d = screen.getByText("Nicht abfragbar (4)").closest("details")!;
    expect(within(d).getByText(/Google AI Studio/).closest("li")).toHaveTextContent("No public subscription-quota API for this provider.");
    expect(within(d).getByText(/Omniroute/).closest("li")).toHaveTextContent("Provider not in the Hermes catalog.");
    expect(screen.queryByRole("listitem", { name: "Google AI Studio" })).not.toBeInTheDocument();
    // OpenCode Zen ist abfragefähig, liefert aber nichts: eigener Block mit Badge und Grund
    const zen = block("OpenCode Zen");
    expect(zen.getByText("Nicht abfragbar")).toBeInTheDocument();
    expect(zen.getByText(/pay-as-you-go/)).toBeInTheDocument();
  });
});

describe("QuotaBars: Zustände", () => {
  it("explains a missing plugin with a copyable command and the install script", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: write } });
    render(<QuotaBars quota={{ ...real, state: "plugin_missing", reason: "Plugin ai-usage-tracker auf diesem Host nicht installiert", providers: [] }} />);
    expect(screen.getByText(/Plugin ai-usage-tracker auf diesem Host nicht installiert/)).toBeInTheDocument();
    expect(screen.getByText("deploy/install-quota-plugin.sh")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Befehl kopieren" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith("hermes plugins install ai-usage-tracker --enable"));
  });

  it.each(["dashboard_unavailable", "error"] as const)("shows the reason for %s", (state) => {
    render(<QuotaBars quota={{ ...real, state, reason: "Das Dashboard ist nicht erreichbar", providers: [] }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Kontingente nicht abfragbar: Das Dashboard ist nicht erreichbar");
  });

  it("colors by remaining percent: green above 30, yellow 10 to 30, red below 10, grey unknown", () => {
    const w = (label: string, rest: number | null) => ({ label, used_percent: null, remaining_percent: rest, reset_at: null, reset_in_s: null, detail: null });
    const p = { ...real.providers[0], label: "T", windows: [w("a", 31), w("b", 30), w("c", 10), w("d", 9.5), w("e", null)] };
    render(<QuotaBars quota={{ ...real, providers: [p] }} />);
    const cls = (name: string) => screen.getByRole("progressbar", { name }).querySelector("i")!.className;
    expect([cls("a: 31 % übrig"), cls("b: 30 % übrig"), cls("c: 10 % übrig"), cls("d: 9,5 % übrig"), cls("e: unbekannt")]).toEqual(["q-ok", "q-mid", "q-mid", "q-bad", "q-unk"]);
  });
});

async function openPage(path: string, mode: QuotaMode, agents = ["default", "sora"]) {
  const b = installBackend(agents);
  b.quota.mode = mode;
  b.dash.keys.OPENCODE_GO_API_KEY = "oc-geheim";  // der Key ist eingetragen; das Plugin meldet ihn als abgelaufen
  history.pushState(null, "", path);
  render(<App />);
  return b;
}

describe("Keys & Nutzung", () => {
  it("replaces the old placeholder with the quota section, reloads on demand with refresh=1", async () => {
    const b = await openPage("/h/hikari/hermes/default/providers", "ok");
    const section = await screen.findByRole("region", { name: "Restkontingente" });
    expect(await within(section).findByRole("listitem", { name: "Anthropic" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("zeigt die WebUI noch nicht");
    fireEvent.click(within(section).getByRole("button", { name: "Restkontingente neu laden" }));
    await waitFor(() => expect(b.calls.some((c) => c.url === "/bff/h/hikari/hermes/default/quota?refresh=1")).toBe(true));
  });

  it("says plainly when the plugin is missing", async () => {
    await openPage("/h/hikari/hermes/default/providers", "missing");
    expect(await screen.findByText(/Plugin ai-usage-tracker auf diesem Host nicht installiert/)).toBeInTheDocument();
  });

  it("refreshes every 60 s only while the tab is visible", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const b = await openPage("/h/hikari/hermes/default/providers", "ok");
      await screen.findByRole("listitem", { name: "Anthropic" });
      const n = () => b.calls.filter((c) => c.url.endsWith("/default/quota")).length;
      const before = n();
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(n()).toBe(before);
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      await vi.advanceTimersByTimeAsync(60_000);
      await waitFor(() => expect(n()).toBe(before + 1));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Anbieter-Hub", () => {
  const hikari = async () => {
    const region = await screen.findByRole("region", { name: "Anbieter auf Hikari" });
    await within(region).findByRole("table");
    return region;
  };

  it("shows the quota under the table and loads it after the table without blocking it", async () => {
    await openPage("/providers", "ok");
    const host = await hikari();
    const group = await within(host).findByRole("group", { name: "Kontingente von default" });
    expect(await within(group).findByRole("listitem", { name: "OpenCode Go" })).toBeInTheDocument();
    expect(within(host).getByRole("group", { name: "Kontingente von sora" })).toBeInTheDocument();
  });

  it("marks a profile with an expired access as 'Zugang prüfen' with the reason as tooltip, only in that profile", async () => {
    await openPage("/providers", "expired");
    const host = await hikari();
    const cell = await within(host).findByRole("button", { name: /^OpenCode Go für default.*Zugang prüfen$/ });
    expect(cell).toHaveTextContent("Zugang prüfen");
    expect(cell).toHaveAttribute("title", "HTTP 401 unauthorized: Key abgelaufen");
    expect(within(host).getByRole("button", { name: /^OpenCode Go für sora/ })).not.toHaveTextContent("Zugang prüfen");
    expect(within(host).getByRole("button", { name: /^Claude für default/ })).not.toHaveTextContent("Zugang prüfen");
  });

  it("shows the missing plugin once per host instead of once per profile", async () => {
    await openPage("/providers", "missing");
    const host = await hikari();
    expect(await within(host).findAllByText(/Plugin ai-usage-tracker auf diesem Host nicht installiert/)).toHaveLength(1);
  });
});

describe("Cockpit", () => {
  it("shows the worst window of all profiles; exhausted is red", async () => {
    await openPage("/", "ok", ["raiden"]);
    const kpi = await screen.findByLabelText("Kontingent");
    expect(kpi).toHaveClass("hot");
    expect(kpi).toHaveTextContent("0% Rest");
    expect(kpi).toHaveTextContent(/(ChatGPT or Codex Subscription · Session|OpenCode Go · Monthly) · raiden · Reset in/);
    expect(kpi).toHaveTextContent("1 Zugang abgelaufen (Nous Portal, raiden)");
  });

  it("names the host when the plugin is missing, and is not red", async () => {
    await openPage("/", "missing", ["raiden"]);
    const kpi = await screen.findByLabelText("Kontingent");
    expect(kpi).not.toHaveClass("hot");
    expect(kpi).toHaveTextContent("hikari: Plugin ai-usage-tracker auf diesem Host nicht installiert");
  });
});
