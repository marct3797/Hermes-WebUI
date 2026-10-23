import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import type { MemGraph } from "../../types";
import { GraphView } from "./GraphView";

/** Zwei dichte Themen (je `n` Fakten, alle untereinander verbunden), eine Brücke dazwischen, ein Einzelner. */
function graph(n = 12): MemGraph {
  const nodes = [...Array.from({ length: n }, (_, i) => ({ id: `a${i}`, label: `Hikari-Fakt ${i}`, kind: null })),
    ...Array.from({ length: n }, (_, i) => ({ id: `b${i}`, label: `Kanban-Fakt ${i}`, kind: null })), { id: "z", label: "Allein", kind: null }];
  const edges: MemGraph["edges"] = [];
  for (const p of ["a", "b"]) for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) edges.push({ source: `${p}${i}`, target: `${p}${j}`, label: "entity" });
  edges.push({ source: "a0", target: "b0", label: "semantic" });
  return { nodes, edges, total: nodes.length, truncated: false };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function open(n = 12) {
  vi.spyOn(api, "memoryGraph").mockResolvedValue(graph(n));
  render(<GraphView provider="hindsight" />);
  return screen.findByRole("group", { name: "Wissensgraph" });
}

describe("GraphView", () => {
  it("shows the dense memory as groups, not as a hairball of lines", async () => {
    const svg = await open();
    const side = screen.getByRole("complementary", { name: "Auswahl" });
    expect(within(side).getAllByRole("button", { pressed: false })).toHaveLength(2); // zwei Gruppen
    expect(screen.getByText("25 Knoten · 133 Kanten")).toBeInTheDocument();
    expect(svg.querySelectorAll("line.ge.bb").length).toBeLessThan(133 / 1.5); // das Gerüst, nicht alle 133 Linien
    expect(svg.querySelectorAll("circle.bubble")).toHaveLength(2);
    expect(new Set([...svg.querySelectorAll("g.gn")].map((g) => g.getAttribute("class")?.match(/gg\d|gg-none/)?.[0])).size).toBe(3); // zwei Farben plus „ohne Gruppe“
  });

  it("labels the groups, but not every node of a big memory, at the start", async () => {
    const svg = await open(25);
    expect(svg.querySelectorAll("text.gt")).toHaveLength(2);
    expect(svg.querySelectorAll("g.gn text").length).toBe(0); // Gruppentitel genügen; Knotennamen kommen bei Auswahl und Zoom
  });

  it("zooms to a group when it is picked in the list and dims the other group", async () => {
    const svg = await open();
    const layer = svg.querySelector("svg > g, g")!;
    expect(layer.getAttribute("transform")).toContain("scale(1)");
    const side = screen.getByRole("complementary", { name: "Auswahl" });
    fireEvent.click(within(side).getAllByRole("button", { pressed: false })[0]);
    await waitFor(() => expect(layer.getAttribute("transform")).not.toContain("scale(1)"));
    const dimmed = [...svg.querySelectorAll("g.gn.dim")].length;
    expect(dimmed).toBeGreaterThanOrEqual(12);
    fireEvent.click(screen.getByRole("button", { name: "Ansicht zurücksetzen" }));
    expect(layer.getAttribute("transform")).toContain("scale(1)");
    expect(svg.querySelectorAll("g.gn.dim")).toHaveLength(0);
  });

  it("names the group of a picked node and lists its strongest links first", async () => {
    const svg = await open(25);
    fireEvent.click(within(svg).getByRole("button", { name: /^Hikari-Fakt 0,/ }));
    const side = screen.getByRole("complementary", { name: "Auswahl" });
    expect(within(side).getByText(/Gruppe/)).toBeInTheDocument();
    expect(within(side).getByText("Verbunden mit (25)")).toBeInTheDocument(); // 24 im Thema plus die Brücke
    expect(within(side).getByText(/… und 13 weitere, schwächere/)).toBeInTheDocument();
    expect(svg.querySelector("g.gn.on text")?.textContent).toMatch(/Hikari-Fakt 0/); // die Auswahl trägt ihren Namen
  });
});
