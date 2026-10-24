import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { installBackend } from "../test-backend";
import type { KnowledgeProvider } from "../types";

const RAG: KnowledgeProvider = { id: "rag", label: "Wissen", type: "hermes-rag", has_sources: true };
let h: ReturnType<typeof installBackend>;

async function open(providers: KnowledgeProvider[] = [RAG]) {
  h = installBackend(["gamma"], ["runs"], {}, undefined, providers);
  history.pushState(null, "", "/knowledge");
  render(<App />);
  await screen.findByRole("heading", { name: "Wissen", level: 1 });
  if (providers.length) await screen.findByLabelText("Wissen durchsuchen"); // erst wenn die Anbieter geladen sind
}
const search = async (q: string) => {
  fireEvent.change(screen.getByLabelText("Wissen durchsuchen"), { target: { value: q } });
  fireEvent.click(screen.getByRole("button", { name: "Suchen" }));
};

beforeEach(() => {
  resetRedirect();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); } });
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

describe("Wissen", () => {
  it("shows exact numbers in German format in the header chips", async () => {
    await open();
    const stats = await screen.findByRole("group", { name: "Statistik" });
    expect(within(stats).getByText("7.047")).toBeInTheDocument(); // aus rag_stats_clean.json
    expect(within(stats).getByText("BAAI/bge-m3")).toBeInTheDocument();
    expect(within(stats).getByText("512 / 50")).toBeInTheDocument();
    expect(within(stats).getByText("Dokumente").parentElement).toHaveTextContent("4"); // 4 sync_ids in chroma_get_clean.json
    expect(within(stats).getByText("Quellen").parentElement).toHaveTextContent("3");
  });

  it("searches, shows the score bar with two decimals and links only hits that have a url", async () => {
    await open();
    await search("Forgejo Runner");
    const hits = await screen.findAllByRole("listitem");
    expect(hits).toHaveLength(2);
    expect(h.calls.find((c) => c.url.endsWith("/search"))?.body).toEqual({ query: "Forgejo Runner", top_k: 8 });
    expect(within(hits[0]).getByLabelText("Score 0,72")).toBeInTheDocument();
    const link = within(hits[0]).getByRole("link", { name: "Im Repo öffnen" });
    expect(link).toHaveAttribute("href", expect.stringMatching(/^https:\/\/git\.example\.com\/example-org\/infrastruktur-doku\/src\/commit\/95c5/));
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(hits[1]).queryByRole("link")).toBeNull();
  });

  it("says so when nothing matches and shows the reason when the search fails", async () => {
    await open();
    await search("nichts da");
    expect(await screen.findByText("Keine Treffer.")).toBeInTheDocument();
    h.kn.searchError = "Wissensdienst nicht erreichbar";
    await search("Forgejo");
    expect(await screen.findByText(/Suche fehlgeschlagen: Wissensdienst nicht erreichbar/)).toBeInTheDocument();
  });

  it("filters by source: a click in the sources table sets the filter used by search and documents", async () => {
    await open();
    const table = (await screen.findByRole("region", { name: "Quellen" }));
    expect(await within(table).findByText("example-org/skills")).toBeInTheDocument();
    fireEvent.click(within(table).getByRole("button", { name: "skills" }));
    expect(screen.getByLabelText("Quelle")).toHaveValue("skills");
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Dokumente" })).queryByText("docs:guide/intro.md")).toBeNull());
    await search("x");
    await waitFor(() => expect(h.calls.find((c) => c.url.endsWith("/search"))?.body).toEqual({ query: "x", top_k: 8, source: "skills" }));
  });

  it("falls back to a free source field and explains why, when no source list exists", async () => {
    await open([{ ...RAG, has_sources: false }]);
    h.kn.available = false;
    expect(await screen.findByLabelText("Quelle")).toHaveProperty("tagName", "INPUT");
    expect(screen.getAllByText(/Keine chroma_url konfiguriert/).length).toBeGreaterThan(0);
  });

  it("warns when the scan was cut off", async () => {
    h = installBackend(["gamma"], ["runs"], {}, undefined, [RAG]);
    h.kn.truncated = true;
    history.pushState(null, "", "/knowledge");
    render(<App />);
    expect(await screen.findByText(/die Übersicht ist unvollständig/)).toBeInTheDocument();
  });

  it("filters documents by text, also by title", async () => {
    await open();
    const docs = await screen.findByRole("region", { name: "Dokumente" });
    await within(docs).findByText("docs:guide/setup.md");
    fireEvent.change(within(docs).getByLabelText("Dokumente filtern"), { target: { value: "NOTIZ" } });
    await waitFor(() => expect(within(docs).queryByText("docs:guide/setup.md")).toBeNull());
    expect(within(docs).getByText("Notiz 1")).toBeInTheDocument();
  });

  it("deletes only after the sync_id was typed, and tells that the sync may bring it back", async () => {
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "docs:guide/setup.md löschen" }));
    const dialog = screen.getByRole("dialog", { name: "Dokument löschen" });
    expect(within(dialog).getByText(/Der Sync fügt dieses Dokument erst wieder hinzu, wenn sich die Datei im Repository ändert\./)).toBeInTheDocument();
    const go = within(dialog).getByRole("button", { name: "Endgültig löschen" });
    expect(go).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Kennung zur Bestätigung"), { target: { value: "docs:guide/setu" } });
    expect(go).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Kennung zur Bestätigung"), { target: { value: "docs:guide/setup.md" } });
    fireEvent.click(go);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(h.calls.find((c) => c.url.endsWith("/delete"))?.body).toEqual({ sync_id: "docs:guide/setup.md" });
    await waitFor(() => expect(screen.queryByText("docs:guide/setup.md")).toBeNull());
  });

  it("asks for a fresh login when deleting needs a step-up, and keeps the dialog", async () => {
    await open();
    h.kn.stepUp = true;
    fireEvent.click(await screen.findByRole("button", { name: "manual:notiz-1 löschen" }));
    fireEvent.change(screen.getByLabelText("Kennung zur Bestätigung"), { target: { value: "manual:notiz-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Endgültig löschen" }));
    expect(await screen.findByText(/frische Anmeldung/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Erneut anmelden" })).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes the dialog with Escape", async () => {
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "manual:notiz-1 löschen" }));
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: false, cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ingests text with a character counter and reports the id; a duplicate shows the 409 message", async () => {
    await open();
    fireEvent.click(await screen.findByText("Text einspeisen"));
    fireEvent.change(screen.getByLabelText("Titel"), { target: { value: "Neue Notiz" } });
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "Hallo" } });
    expect(screen.getByText("5 / 1.048.576 Zeichen")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Einspeisen" }));
    expect(await screen.findByText("Eingespeist als manual:neue-notiz.")).toBeInTheDocument();
    expect(h.calls.find((c) => c.url.endsWith("/ingest"))?.body).toEqual({ title: "Neue Notiz", text: "Hallo" });
    expect(await screen.findByText("manual:neue-notiz")).toBeInTheDocument(); // Liste lädt neu
    fireEvent.change(screen.getByLabelText("Titel"), { target: { value: "Neue Notiz" } });
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "nochmal" } });
    fireEvent.click(screen.getByRole("button", { name: "Einspeisen" }));
    expect(await screen.findByText(/schon ein Dokument mit der Kennung manual:neue-notiz/)).toBeInTheDocument();
  });

  it("blocks ingest above 1 MiB of characters", async () => {
    await open();
    fireEvent.click(await screen.findByText("Text einspeisen"));
    fireEvent.change(screen.getByLabelText("Titel"), { target: { value: "T" } });
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "x".repeat(1_048_577) } });
    expect(screen.getByRole("button", { name: "Einspeisen" })).toBeDisabled();
  });

  it("shows why the service is unreachable instead of empty numbers", async () => {
    h = installBackend(["gamma"], ["runs"], {}, undefined, [RAG]);
    h.kn.statsError = "Wissensdienst nicht erreichbar";
    history.pushState(null, "", "/knowledge");
    render(<App />);
    expect(await screen.findByText(/Wissensdienst nicht erreichbar: Wissensdienst nicht erreichbar/)).toBeInTheDocument();
  });

  it("explains the config when no provider exists, and offers a choice with several", async () => {
    await open([]);
    expect(await screen.findByText("Kein Wissens-Anbieter eingerichtet")).toBeInTheDocument();
    expect(screen.getByText("HERMES_WEBUI_KNOWLEDGE_FILE")).toBeInTheDocument();
    cleanup();
    await open([RAG, { ...RAG, id: "zwei", label: "Zweites Wissen" }]);
    expect(await screen.findByRole("combobox", { name: "Anbieter" })).toBeInTheDocument();
  });
});

describe("Dokumentnavigation", () => {
  it("pages beyond the first hundred and resets the offset when filtering", async () => {
    h = installBackend(["gamma"], ["runs"], {}, undefined, [RAG]);
    h.kn.docs = Array.from({ length: 101 }, (_, i) => ({ sync_id: `manual:doc-${i}`, title: `Doc ${i}`, source: "manual", chunks: 1 }));
    history.pushState(null, "", "/knowledge");
    render(<App />);
    expect(await screen.findByText("Doc 0")).toBeInTheDocument();
    expect(screen.queryByText("Doc 100")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Nächste Dokumentseite" }));
    expect(await screen.findByText("Doc 100")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nächste Dokumentseite" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Dokumente filtern"), { target: { value: "Doc 0" } });
    expect(await screen.findByText("Doc 0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Vorherige Dokumentseite" })).toBeDisabled();
  });
});

describe("Wissen in der Navigation", () => {
  it("shows the sidebar entry only when a provider exists", async () => {
    installBackend(["gamma"], ["runs"], {}, undefined, []);
    history.pushState(null, "", "/");
    render(<App />);
    const side = await screen.findByRole("complementary", { name: "Navigation" });
    fireEvent.click(await within(side).findByRole("button", { name: /^Wissen/ }));
    await within(side).findByRole("link", { name: /Gedächtnis/ });
    expect(within(side).queryByRole("link", { name: "Wissen" })).toBeNull();
    cleanup();
    installBackend(["gamma"], ["runs"], {}, undefined, [RAG]);
    render(<App />);
    const side2 = await screen.findByRole("complementary", { name: "Navigation" });
    fireEvent.click(await within(side2).findByRole("button", { name: /^Wissen/ }));
    expect(await within(side2).findByRole("link", { name: "Wissen" })).toHaveAttribute("href", "/knowledge");
  });
});
