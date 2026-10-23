import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { installBackend } from "../test-backend";

let calls: ReturnType<typeof installBackend>["calls"];

async function open(capabilities?: string[]) {
  ({ calls } = installBackend(["raiden"], ["runs"], {}, capabilities));
  history.pushState(null, "", "/memory");
  render(<App />);
  await screen.findByRole("heading", { name: "Gedächtnis", level: 1 });
}
const tab = (name: string) => screen.findByRole("tab", { name });

beforeEach(() => resetRedirect());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Gedächtnis", () => {
  it("shows the provider and only the views it can do", async () => {
    await open(["stats", "items"]);
    expect(await screen.findByText("Hindsight · Bank hermes")).toBeInTheDocument();
    await tab("Übersicht");
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Übersicht", "Fakten"]);
    expect((await screen.findAllByText("120")).length).toBeGreaterThan(0); // total_nodes (und die Summe der Arten)
  });

  it("breaks the counts down by kind and links the most mentioned entities and the newest facts", async () => {
    await open();
    const panel = within(await screen.findByRole("tabpanel"));
    expect((await panel.findByText("Fakten")).parentElement).toHaveTextContent("120"); // total_nodes bekommt einen lesbaren Namen // total_nodes bekommt einen lesbaren Namen
    expect(screen.queryByText("Offene Aufgaben")).not.toBeInTheDocument(); // eine Null ist kein Befund
    const split = await screen.findByRole("region", { name: "Fakten nach Art" });
    expect(within(split).getByText(/Weltwissen/)).toBeInTheDocument();
    expect(within(split).getByText(/67 %/)).toBeInTheDocument();
    expect(within(split).getByRole("img", { name: "Weltwissen 80, Erfahrungen 40" })).toBeInTheDocument();
    const ents = await screen.findByRole("region", { name: "Häufigste Entitäten" });
    fireEvent.click(within(ents).getByRole("button", { name: /^Marc/ }));
    const side = await screen.findByRole("complementary", { name: "Entität" });
    expect(await within(side).findByText(/7 Erwähnungen/)).toBeInTheDocument();
  });

  it("opens a fact in full and jumps from its entity to that entity's page", async () => {
    await open();
    fireEvent.click(await tab("Fakten"));
    fireEvent.click(await screen.findByRole("button", { name: /^Fakt öffnen: Marc betreibt einen Server/ }));
    const fact = await screen.findByRole("complementary", { name: "Fakt" });
    expect(within(fact).getByText("Marc betreibt einen Server namens Hikari.")).toBeInTheDocument();
    expect(within(fact).getByText(/Hindsight bietet keine Schnittstelle/)).toBeInTheDocument();
    fireEvent.click(within(fact).getByRole("button", { name: "Hikari" }));
    expect(await screen.findByRole("tab", { name: "Entitäten", selected: true })).toBeInTheDocument();
    const entity = await screen.findByRole("complementary", { name: "Entität" });
    expect(await within(entity).findByText(/Erwähnungen/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Hikari/, pressed: true })).toBeInTheDocument();
  });

  it("filters the entity list and leads from an entity to all of its facts", async () => {
    await open();
    fireEvent.click(await tab("Entitäten"));
    await screen.findByRole("button", { name: /^Marc/ });
    fireEvent.change(screen.getByLabelText("Entitäten filtern"), { target: { value: "hik" } });
    expect(screen.queryByRole("button", { name: /^Marc/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Entitäten filtern"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /^Marc/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Alle Fakten dazu" }));
    expect(await screen.findByRole("tab", { name: "Fakten", selected: true })).toBeInTheDocument();
    expect(await screen.findByText("Marc hat die WebUI gebaut.")).toBeInTheDocument();
    expect(screen.getByText(/Gefiltert nach „Marc“/)).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("/items") && c.url.includes("q=Marc"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "aufheben" }));
    await waitFor(() => expect(screen.queryByText(/Gefiltert nach/)).not.toBeInTheDocument());
  });

  it("leaves out the mental models tab while there are none", async () => {
    ({ calls } = installBackend());
    const backend = globalThis.fetch;
    let asked = false;
    vi.stubGlobal("fetch", (url: RequestInfo | URL, init?: RequestInit) => {
      if (!String(url).endsWith("/models")) return backend(url, init);
      asked = true;
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), { headers: { "content-type": "application/json" } }));
    });
    history.pushState(null, "", "/memory");
    render(<App />);
    await screen.findByRole("heading", { name: "Gedächtnis", level: 1 });
    await tab("Übersicht");
    await waitFor(() => expect(asked).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("tab", { name: "Modelle" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Graph" })).toBeInTheDocument();
  });

  it("pages through the facts and filters by kind", async () => {
    await open();
    fireEvent.click(await tab("Fakten"));
    expect(await screen.findByText("Marc betreibt einen Server namens Hikari.")).toBeInTheDocument();
    expect(screen.getByText("3 Einträge")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mehr laden" }));
    expect(await screen.findByText("Hikari läuft im Tailnet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mehr laden" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "experience" }));
    await waitFor(() => expect(screen.queryByText("Hikari läuft im Tailnet.")).not.toBeInTheDocument());
    expect(screen.getByText("Marc hat die WebUI gebaut.")).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("/items") && c.url.includes("kind=experience"))).toBe(true);
  });

  it("searches only when asked", async () => {
    await open();
    fireEvent.click(await tab("Suche"));
    expect(calls.some((c) => c.url.includes("/search"))).toBe(false);
    fireEvent.change(screen.getByLabelText("Gedächtnis durchsuchen"), { target: { value: "tailnet" } });
    fireEvent.click(screen.getByRole("button", { name: "Suchen" }));
    expect(await screen.findByText("Hikari läuft im Tailnet.")).toBeInTheDocument();
    expect(calls.filter((c) => c.url.includes("/search")).map((c) => c.url)).toEqual(["/bff/memory/hindsight/search?q=tailnet"]);
  });

  it("draws the graph and lists the neighbours of a clicked node", async () => {
    await open();
    fireEvent.click(await tab("Graph"));
    const graph = await screen.findByRole("group", { name: "Wissensgraph" });
    expect(screen.getByText("3 Knoten · 2 Kanten")).toBeInTheDocument();
    fireEvent.click(within(graph).getByRole("button", { name: /^Hikari \(server\)/ }));
    const side = screen.getByRole("complementary", { name: "Auswahl" });
    expect(within(side).getByText("Verbunden mit (2)")).toBeInTheDocument();
    expect(within(side).getByRole("button", { name: "Marc" })).toBeInTheDocument();
    expect(within(side).getByText(/betreibt/)).toBeInTheDocument();
  });

  it("hides kinds and lone nodes on request, and dims what is not connected to the chosen node", async () => {
    await open();
    fireEvent.click(await tab("Graph"));
    const graph = await screen.findByRole("group", { name: "Wissensgraph" });
    const kinds = screen.getByRole("group", { name: "Arten" });
    fireEvent.click(within(kinds).getByRole("button", { name: /server/ }));
    expect(screen.getByText("1 Knoten · 0 Kanten")).toBeInTheDocument();
    expect(within(kinds).getByRole("button", { name: /server/ })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(within(kinds).getByRole("button", { name: /server/ }));
    expect(screen.getByText("3 Knoten · 2 Kanten")).toBeInTheDocument();
    fireEvent.click(within(graph).getByRole("button", { name: /^Marc \(person\)/ }));
    expect(within(graph).getByRole("button", { name: /^Tailnet/ }).getAttribute("class")).toContain("dim"); // zwei Schritte entfernt
    expect(within(graph).getByRole("button", { name: /^Hikari/ }).getAttribute("class")).not.toContain("dim");
    const links = screen.getByRole("group", { name: "Verbindungen" });
    fireEvent.click(within(links).getByRole("button", { name: "betreibt" }));
    expect(screen.getByText("3 Knoten · 1 Kanten")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /Einzelne ohne Verbindung ausblenden \(1\)/ }));
    expect(screen.getByText("2 Knoten · 1 Kanten")).toBeInTheDocument();
  });

  it("zooms with the buttons and goes back to the full view", async () => {
    await open();
    fireEvent.click(await tab("Graph"));
    const graph = await screen.findByRole("group", { name: "Wissensgraph" });
    const layer = graph.querySelector("svg > g, g")!;
    expect(layer.getAttribute("transform")).toContain("scale(1)");
    fireEvent.click(screen.getByRole("button", { name: "Vergrößern" }));
    expect(layer.getAttribute("transform")).toContain("scale(1.3");
    fireEvent.click(screen.getByRole("button", { name: "Ansicht zurücksetzen" }));
    expect(layer.getAttribute("transform")).toContain("scale(1)");
  });

  it("says so when the graph is empty", async () => {
    await open();
    fireEvent.click(await tab("Graph"));
    await screen.findByRole("group", { name: "Wissensgraph" });
    fireEvent.change(screen.getByLabelText("Graph eingrenzen"), { target: { value: "leer" } });
    fireEvent.click(screen.getByRole("button", { name: "Anzeigen" }));
    expect(await screen.findByText("Der Graph ist leer für diese Eingrenzung.")).toBeInTheDocument();
  });

  it("opens an entity with its observations", async () => {
    await open();
    fireEvent.click(await tab("Entitäten"));
    fireEvent.click(await screen.findByRole("button", { name: /^Marc/ }));
    const side = await screen.findByRole("complementary", { name: "Entität" });
    expect(await within(side).findByText("Marc hat die WebUI gebaut.")).toBeInTheDocument();
    expect(within(side).getByText(/7 Erwähnungen/)).toBeInTheDocument();
  });

  it("renders mental models as markdown", async () => {
    await open();
    fireEvent.click(await tab("Modelle"));
    const card = await screen.findByRole("region", { name: "Zuhause" });
    expect(within(card).getByText("Netz:").tagName).toBe("STRONG");
    expect(within(card).getByText("Leitfrage: Wie sieht das Netz aus?")).toBeInTheDocument();
  });

  it("asks the memory a question only on button press and warns that it costs", async () => {
    await open();
    fireEvent.click(await tab("Fragen"));
    expect(screen.getByText(/verbraucht Kontingent/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/reflect"))).toBe(false);
    fireEvent.change(screen.getByLabelText("Frage ans Gedächtnis"), { target: { value: "Was weiß ich?" } });
    fireEvent.click(screen.getByRole("button", { name: "Fragen" }));
    expect(await screen.findByText("Antwort auf: Was weiß ich?")).toBeInTheDocument();
    expect(screen.getByText("Gestützt auf (1)")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/reflect"))[0].body).toEqual({ query: "Was weiß ich?" });
  });

  it("checks the connection on request and shows deviations", async () => {
    await open();
    await tab("Übersicht");
    expect(calls.some((c) => c.url.endsWith("/diagnose"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Verbindung prüfen/ }));
    expect(await screen.findByText("Graph ohne Kantenbeschriftung")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Abweichung" })).toBeInTheDocument();
  });

  it("is reachable from the sidebar", async () => {
    ({ calls } = installBackend());
    history.pushState(null, "", "/");
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: /Gedächtnis/ }));
    await screen.findByRole("heading", { name: "Gedächtnis", level: 1 });
    expect(location.pathname).toBe("/memory");
  });
});
