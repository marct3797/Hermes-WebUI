import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import real from "../../fixtures/bff_graph_world.json";
import { recencyColor } from "../../graphColor";
import type { MemGraph } from "../../types";
import { GraphView, readGraphQuery } from "./GraphView";

const world = real as unknown as MemGraph;
const fills: string[] = [];
const strokes: string[] = [];

/** Ein Canvas, das mitschreibt, womit gemalt wurde (jsdom hat keins). */
function stubCanvas() {
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (t, k: string) => (k === "fill" ? () => fills.push(String(t.fillStyle)) : k === "stroke" ? () => strokes.push(String(t.strokeStyle)) : k in t ? t[k] : () => undefined),
    set: (t, k: string, v) => { t[k] = v; return true; },
  });
  HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}

beforeEach(() => { fills.length = 0; strokes.length = 0; stubCanvas(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext; });

function open(init = {}, graph: Partial<MemGraph> = {}) {
  const spy = vi.spyOn(api, "memoryGraph").mockImplementation(async (_p, o) => ({ ...world, ...graph, nodes: world.nodes.map((n) => ({ ...n, kind: o?.type ?? "world" })), limit: o?.limit ?? 500 }));
  vi.spyOn(api, "memoryStats").mockResolvedValue({ counts: [{ key: "nodes_by_fact_type.world", value: 44272 }, { key: "nodes_by_fact_type.experience", value: 8854 }] });
  vi.spyOn(api, "memoryTimeseries").mockResolvedValue({ points: [{ t: "2026-10-22T00:00:00+00:00", count: 4 }, { t: "2026-10-23T00:00:00+00:00", count: 21 }] });
  render(<GraphView provider="hindsight" initial={init} />);
  return spy;
}
const canvas = () => screen.findByRole("img", { name: /Gedächtnis-Graph, 25 Erinnerungen/ });

describe("GraphView", () => {
  it("draws the real facts coloured by recency, newest red and oldest blue, with a date scale", async () => {
    open();
    await canvas();
    await waitFor(() => expect(fills.length).toBeGreaterThan(0));
    const ts = world.nodes.map((n) => Date.parse(n.date!));
    expect(fills).toContain(recencyColor(0));
    expect(fills).toContain(recencyColor(1));
    expect(ts.length).toBe(25);
    expect(screen.getByLabelText(/^Aktualität von \d\d\.\d\d\.\d{4} bis \d\d\.\d\d\.\d{4}$/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /gefärbt nach Aktualität/ })).toHaveAttribute("tabindex", "0");
  });

  it("switches the colouring to context and entity and shows a legend", async () => {
    open();
    await canvas();
    fireEvent.change(screen.getByLabelText("Einfärben nach"), { target: { value: "context" } });
    expect(await screen.findByText(/^Docker env_file/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Einfärben nach"), { target: { value: "entity" } });
    const freq = new Map<string, number>();
    for (const n of world.nodes) for (const e of n.entities) freq.set(e, (freq.get(e) ?? 0) + 1);
    const top = [...freq].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    expect(await screen.findByText(new RegExp(`^${top}`))).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Einfärben nach"), { target: { value: "group" } });
    expect(screen.getByRole("img", { name: /gefärbt nach Gruppen/ })).toBeInTheDocument();
  });

  it("lists the link types of the data and the legend hides one from drawing and layout", async () => {
    open();
    await canvas();
    const box = screen.getByRole("group", { name: "Verknüpfungstypen" });
    expect(within(box).getByLabelText(/Temporal/)).toBeChecked();
    expect(within(box).getByLabelText(/Semantic/)).toBeChecked();
    expect(within(box).getByLabelText(/Causal/)).toBeChecked();
    await waitFor(() => expect(strokes).toContain("#2dd4bf"));
    fireEvent.click(within(box).getByLabelText(/Temporal/));
    expect(within(box).getByLabelText(/Temporal/)).not.toBeChecked();
    expect(screen.getByRole("img", { name: /25 Erinnerungen und 4 Verbindungen/ })).toBeInTheDocument(); // 21 Temporal weniger
    strokes.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Vergrößern" })); // neues Bild
    await waitFor(() => expect(strokes.length).toBeGreaterThan(0));
    expect(strokes).not.toContain("#2dd4bf");
  });

  it("asks the BFF for the fact type, filters on Enter and loads more in steps up to 2000", async () => {
    const spy = open();
    spy.mockImplementation(async (_p, o) => ({ ...world, total: 44272, returned: o?.limit ?? 500, limit: o?.limit ?? 500 })); // der Dienst liefert so viele, wie verlangt
    fireEvent.click(await screen.findByRole("tab", { name: /^Weltfakten/ }));
    fireEvent.change(await screen.findByLabelText("Nach Text oder Kontext filtern"), { target: { value: "" } });
    fireEvent.submit(screen.getByLabelText("Nach Text oder Kontext filtern").closest("form")!);
    await canvas();
    expect(spy).toHaveBeenLastCalledWith("hindsight", expect.objectContaining({ type: "world", limit: 500 }));
    fireEvent.click(screen.getByRole("tab", { name: /^Erfahrung/ }));
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith("hindsight", expect.objectContaining({ type: "experience", limit: 500 })));
    const filter = await screen.findByLabelText("Nach Text oder Kontext filtern");
    fireEvent.change(filter, { target: { value: "Codex" } });
    fireEvent.submit(filter.closest("form")!);
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith("hindsight", expect.objectContaining({ type: "experience", q: "Codex" })));
    for (const next of [1000, 2000]) {
      fireEvent.click(await screen.findByRole("button", { name: "Weitere laden" }));
      await waitFor(() => expect(spy).toHaveBeenLastCalledWith("hindsight", expect.objectContaining({ limit: next })));
    }
    const last = await screen.findByRole("button", { name: "Weitere laden" });
    await waitFor(() => expect(last).toBeDisabled());
    expect(screen.getByText(/Control-Plane/)).toBeInTheDocument();
    expect(screen.getByText(/2\.000 von 44\.272 Erinnerungen werden angezeigt/)).toBeInTheDocument();
  });

  it("sends tags as a list and the match mode only for several tags", async () => {
    const spy = open();
    await canvas();
    const tags = screen.getByLabelText("Nach Tags filtern");
    fireEvent.change(tags, { target: { value: "infra, session:abc" } });
    fireEvent.submit(tags.closest("form")!);
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith("hindsight", expect.objectContaining({ tags: ["infra", "session:abc"], tags_match: "any" })));
  });

  it("selects a row, shows text, entities as chips and connections by type, and highlights neighbours", async () => {
    open();
    await canvas();
    fireEvent.click(screen.getByRole("button", { name: "Tabelle" }));
    const first = world.table_rows[0];
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${first.text!.slice(0, 30)}`) }));
    const side = screen.getByRole("complementary", { name: "Auswahl" });
    expect(within(side).getByText(first.text!)).toBeInTheDocument();
    for (const e of first.entities) expect(within(side).getByText(e)).toBeInTheDocument();
    expect(within(side).getByText(/^Verbindungen \(\d+\)/)).toBeInTheDocument();
    const hl = within(side).getByRole("button", { name: "Nachbarn hervorheben" });
    expect(hl).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(hl);
    expect(hl).toHaveAttribute("aria-pressed", "true");
  });

  it("sorts the table by date and context and has the four columns", async () => {
    open();
    await canvas();
    fireEvent.click(screen.getByRole("button", { name: "Tabelle" }));
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent?.replace(/ [▲▼]$/, ""))).toEqual(["Text", "Kontext", "Entitäten", "Datum"]);
    const ctx = () => within(table).getAllByRole("row").slice(1).map((r) => r.children[1].textContent);
    fireEvent.click(within(table).getByRole("button", { name: "Kontext" }));
    expect(ctx()).toEqual([...ctx()].sort((a, b) => a!.localeCompare(b!, "en")).sort((a, b) => (a === b ? 0 : (a ?? "").toLowerCase() < (b ?? "").toLowerCase() ? -1 : 1)));
    expect(within(table).getByRole("columnheader", { name: /Kontext/ })).toHaveAttribute("aria-sort", "ascending");
  });

  it("filters the table by a timeline bar", async () => {
    open();
    await canvas();
    fireEvent.click(screen.getByRole("button", { name: "Zeitleiste" }));
    const bar = await screen.findByRole("button", { name: /^22\.10\.2026: 4 Erinnerungen$/ });
    expect(screen.getAllByRole("row").length).toBe(26);
    fireEvent.click(bar);
    expect(await screen.findByText("Keine Erinnerungen für diesen Filter")).toBeInTheDocument(); // die echten Daten sind alle vom 23.10.
    fireEvent.click(screen.getByRole("button", { name: /^23\.10\.2026: 21/ }));
    expect(screen.getAllByRole("row").length).toBe(26);
    fireEvent.click(screen.getByRole("button", { name: "Zeitraum aufheben" }));
    expect(screen.queryByText(/^Zeitraum:/)).not.toBeInTheDocument();
  });

  it("falls back to the loaded dates when the time series is missing", async () => {
    open();
    vi.spyOn(api, "memoryTimeseries").mockRejectedValue(new Error("nein"));
    await canvas();
    fireEvent.click(screen.getByRole("button", { name: "Zeitleiste" }));
    expect(await screen.findByText(/Nur die geladenen Erinnerungen/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^23\.10\.2026: 25 Erinnerungen$/ })).toBeInTheDocument();
  });

  it("pauses the layout, goes fullscreen with a fallback and copies the share link", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    open({ q: "Codex", tags: ["a", "b"], tags_match: "all" });
    await canvas();
    const pause = screen.getByRole("button", { name: "Pause" });
    fireEvent.click(pause);
    expect(screen.getByRole("button", { name: "Weiter" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Vollbild" })); // jsdom hat keine Fullscreen-API: CSS-Ersatz
    expect(await screen.findByRole("button", { name: "Vollbild beenden" })).toBeInTheDocument();
    expect(document.querySelector(".graph-stage")).toHaveClass("full");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Teilen" })); });
    expect(writeText).toHaveBeenCalledWith(`${location.origin}${location.pathname}?tab=graph&type=world&limit=500&q=Codex&tags=a&tags=b&tags_match=all`);
    expect(await screen.findByText("Link kopiert")).toBeInTheDocument();
  });

  it("zooms with the keyboard and the wheel without errors", async () => {
    open();
    const c = await canvas();
    for (const key of ["+", "-", "ArrowLeft", "ArrowUp", "0"]) fireEvent.keyDown(c, { key });
    fireEvent.wheel(c, { deltaY: -100, clientX: 10, clientY: 10 });
    fireEvent.doubleClick(c, { clientX: 50, clientY: 50 });
    fireEvent.pointerMove(c, { clientX: 5, clientY: 5 });
    expect(c).toBeInTheDocument();
  });

  it("says so for an empty filter and for errors, and retries", async () => {
    const spy = vi.spyOn(api, "memoryGraph").mockResolvedValue({ ...world, nodes: [], edges: [], table_rows: [], total: 0, returned: 0 });
    vi.spyOn(api, "memoryStats").mockResolvedValue({ counts: [] });
    render(<GraphView provider="hindsight" />);
    expect(await screen.findByText("Keine Erinnerungen für diesen Filter")).toBeInTheDocument();
    spy.mockRejectedValueOnce(new Error("Hindsight antwortet nicht rechtzeitig"));
    fireEvent.submit(screen.getByLabelText("Nach Text oder Kontext filtern").closest("form")!);
    expect(await screen.findByText(/Graph nicht ladbar: Hindsight antwortet nicht rechtzeitig/)).toBeInTheDocument();
    spy.mockImplementation(async () => world);
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await canvas();
    expect(spy).toHaveBeenLastCalledWith("hindsight", expect.objectContaining({ refresh: true }));
  });

  it("shows a skeleton while loading", async () => {
    vi.spyOn(api, "memoryGraph").mockReturnValue(new Promise(() => undefined));
    vi.spyOn(api, "memoryStats").mockResolvedValue({ counts: [] });
    render(<GraphView provider="hindsight" />);
    expect(screen.getByRole("status", { name: "Lade Graph" })).toBeInTheDocument();
  });
});

describe("readGraphQuery", () => {
  it("reads a shared address and ignores nonsense", () => {
    expect(readGraphQuery("?tab=graph&type=experience&limit=1000&q=x&tags=a&tags=b&tags_match=all")).toEqual({ tab: "graph", type: "experience", limit: 1000, q: "x", tags: ["a", "b"], tags_match: "all" });
    expect(readGraphQuery("?type=opinion&limit=99999&tags_match=none")).toEqual({ tab: undefined, type: undefined, limit: undefined, q: undefined, tags: undefined, tags_match: undefined });
  });
});
