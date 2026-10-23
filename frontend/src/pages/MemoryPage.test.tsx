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
    expect(await screen.findByText("120")).toBeInTheDocument(); // total_nodes
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
