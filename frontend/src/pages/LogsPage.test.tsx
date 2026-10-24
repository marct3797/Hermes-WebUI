import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import views from "../fixtures/ops_cron_views.json";
import { LogsPage } from "./LogsPage";

vi.mock("../hosts", () => ({ useHosts: () => ({ hosts: [{ id: "ct", label: "Server", runtimes: [{ id: "hermes", agents: [{ id: "alpha", label: "Alpha" }] }] }] }) }));

let queries: URLSearchParams[];
let lines: string[];
let failing: string | undefined;
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const view = () => screen.getByLabelText("Logzeilen");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  queries = []; lines = [...views.logs.lines]; failing = undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = new URL(url, "http://x");
    queries.push(u.searchParams);
    if (failing) return new Response(JSON.stringify({ detail: failing }), { status: 502 });
    return new Response(JSON.stringify({ file: u.searchParams.get("file"), lines, redacted: true, truncated: false }), { status: 200 });
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function open() { render(<LogsPage host="ct" />); await flush(); }

describe("Logs", () => {
  it("loads the default view and marks levels by color class and secrets as redacted", async () => {
    await open();
    expect(Object.fromEntries(queries[0])).toEqual({ file: "agent", lines: "200", level: "ALL", component: "all", profile: "alpha" });
    expect(view().children).toHaveLength(4);
    expect(view().children[1]).toHaveClass("logs-WARNING");
    expect(view().children[2]).toHaveClass("logs-ERROR");
    expect(screen.getByRole("status")).toHaveTextContent("4 Zeilen");
    expect(screen.getByRole("status")).toHaveTextContent("Geheimnisse sind serverseitig geschwärzt");
  });

  it("sends file, lines, level, component and the search term to the BFF", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Datei"), { target: { value: "errors" } });
    await flush();
    fireEvent.change(screen.getByLabelText("Zeilen"), { target: { value: "500" } });
    await flush();
    fireEvent.change(screen.getByLabelText("Stufe"), { target: { value: "ERROR" } });
    await flush();
    fireEvent.change(screen.getByLabelText("Komponente"), { target: { value: "cron" } });
    await flush();
    fireEvent.change(screen.getByLabelText("Volltextsuche"), { target: { value: "terminal" } });
    fireEvent.click(screen.getByRole("button", { name: "Suchen" }));
    await flush();
    expect(Object.fromEntries(queries.at(-1)!)).toEqual({ file: "errors", lines: "500", level: "ERROR", component: "cron", search: "terminal", profile: "alpha" });
  });

  it("reloads on demand", async () => {
    await open();
    const n = queries.length;
    lines = ["2026-10-24 04:00:00,000 INFO [x] agent.run: neu"];
    fireEvent.click(screen.getByRole("button", { name: "Neu laden" }));
    await flush();
    expect(queries.length).toBe(n + 1);
    expect(view().children).toHaveLength(1);
  });

  it("live mode polls every 3 seconds, appends only new lines and can be paused", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Live starten" }));
    const n = queries.length;
    await tick(2900);
    expect(queries.length).toBe(n);
    lines = [...lines, "2026-10-24 03:32:00,000 INFO [x] agent.run: fünf"];
    await tick(200);
    expect(queries.length).toBe(n + 1);
    expect(view().children).toHaveLength(5);
    expect(screen.getByRole("status")).toHaveTextContent("Live: alle 3 Sekunden");
    await tick(3000);  // nichts Neues: keine Duplikate
    expect(view().children).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Live pausieren" }));
    const m = queries.length;
    await tick(9000);
    expect(queries.length).toBe(m);
  });

  it("scrolls to the bottom while following and stops when switched off", async () => {
    await open();
    const el = view();
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 999 });
    fireEvent.click(screen.getByRole("button", { name: "Neu laden" }));
    await flush();
    expect(el.scrollTop).toBe(999);
    fireEvent.click(screen.getByLabelText("Automatisch nach unten"));
    el.scrollTop = 5;
    fireEvent.click(screen.getByRole("button", { name: "Neu laden" }));
    await flush();
    expect(el.scrollTop).toBe(5);
  });

  it("toggles wrapping and copies the visible lines", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await open();
    expect(view()).not.toHaveClass("wrap");
    fireEvent.click(screen.getByLabelText("Zeilen umbrechen"));
    expect(view()).toHaveClass("wrap");
    fireEvent.click(screen.getByRole("button", { name: "Kopieren" }));
    await flush();
    expect(writeText).toHaveBeenCalledWith(lines.join("\n"));
    expect(screen.getByRole("status")).toHaveTextContent("4 Zeilen kopiert.");
  });

  it("downloads the visible lines as a file named after the log", async () => {
    const urls: Blob[] = [];
    Object.assign(URL, { createObjectURL: (b: Blob) => { urls.push(b); return "blob:x"; }, revokeObjectURL: () => undefined });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Herunterladen" }));
    expect(click).toHaveBeenCalled();
    const text = await new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsText(urls[0]); });
    expect(text).toBe(lines.join("\n") + "\n");
  });

  it("explains an empty result and shows the reason for an error", async () => {
    lines = [];
    await open();
    expect(screen.getByText(/Keine Zeilen für diese Auswahl/)).toBeInTheDocument();
    failing = "Das Dashboard ist nicht erreichbar";
    fireEvent.click(screen.getByRole("button", { name: "Neu laden" }));
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("Logs nicht ladbar: Das Dashboard ist nicht erreichbar");
  });
});
