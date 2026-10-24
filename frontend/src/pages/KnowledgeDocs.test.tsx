import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRedirect } from "../api";
import { KnowledgePage } from "./KnowledgePage";

const INTRO = "docs:guide/intro.md", NOTE = "manual:notiz";
const parts = ["Erster Absatz der Einleitung.", "Zweiter Absatz mit dem Suchwort Marzipan.", "Dritter Absatz."];
type Call = { method: string; url: string; body: any };
let calls: Call[];
let docs: Record<string, { source: string; title: string | null; path: string | null; chunks: number; text: string; parts: string[] }>;
let failPut: { status: number; body: unknown } | undefined;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

beforeEach(() => {
  resetRedirect();
  calls = []; failPut = undefined;
  docs = {
    [INTRO]: { source: "docs", title: null, path: "guide/intro.md", chunks: 3, text: parts.join("\n\n"), parts },
    [NOTE]: { source: "manual", title: "Notiz", path: null, chunks: 1, text: "Eine kurze Notiz.", parts: ["Eine kurze Notiz."] },
  };
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const u = new URL(url, "http://x");
    if (u.pathname === "/bff/knowledge") return json({ providers: [{ id: "rag", label: "Wissen", type: "hermes-rag", has_sources: true }], config_error: null });
    const m = /^\/bff\/knowledge\/rag\/(.*)$/.exec(decodeURIComponent(u.pathname));
    const rest = m?.[1] ?? "";
    if (rest === "stats") return json({ reachable: true, collection: "c", count: 4, embedding_model: "m", chunk_size: 512, chunk_overlap: 50, documents: 2, sources: 2 });
    if (rest === "sources") return json({ available: true, reason: null, scanned_chunks: 4, truncated: false, cache_age_s: 0, items: [{ source: "docs", chunks: 3, documents: 1, repos: ["example-org/docs"] }, { source: "manual", chunks: 1, documents: 1, repos: [] }] });
    if (rest === "documents") {
      const src = u.searchParams.get("source");
      const items = Object.entries(docs).filter(([, d]) => !src || d.source === src).map(([sync_id, d]) => ({ sync_id, source: d.source, repo: null, path: d.path, commit: null, chunks: d.chunks, title: d.title }));
      return json({ available: true, reason: null, items, total: items.length });
    }
    if (rest === "search") return json({ results: [{ text: parts[1], score: 0.81, source: "docs", repo: null, path: "guide/intro.md", commit: null, sync_id: INTRO, url: null }, { text: "ohne Kennung", score: 0.5, source: null, repo: null, path: null, commit: null, sync_id: null, url: null }] });
    if (rest === "ingest") return json({ ok: true, sync_id: "manual:neu" });
    if (rest.startsWith("documents/")) {
      const id = rest.slice("documents/".length);
      const d = docs[id];
      if (!d) return json({ detail: "Dokument nicht gefunden" }, 404);
      if (method === "PUT") {
        if (failPut) return json(failPut.body, failPut.status);
        d.text = body.text; d.parts = [body.text]; d.chunks = 1; if (body.title) d.title = body.title;
        return json({ ok: true, sync_id: id, chunks: 1, removed: 3 });
      }
      return json({ sync_id: id, source: d.source, repo: null, path: d.path, commit: null, title: d.title, chunks: d.chunks, truncated: false, editable: true, text: d.text, parts: d.parts.map((text, index) => ({ index, text })) });
    }
    return json({ detail: "unbekannt" }, 404);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal"); });

async function open() {
  render(<KnowledgePage />);
  await screen.findByLabelText("Wissen durchsuchen");
  await screen.findByRole("button", { name: "guide/intro.md" });
}

describe("Wissen: Quelle, Dokument, Detail, Bearbeiten", () => {
  it("opens a source from its row and shows document and chunk counts", async () => {
    await open();
    const sources = screen.getByRole("region", { name: "Quellen" });
    fireEvent.click(within(sources).getByText("example-org/docs").closest("tr")!);  // ganze Zeile ist klickbar
    const head = await screen.findByRole("region", { name: "Quellenansicht" });
    expect(head).toHaveTextContent("Quelle docs");
    expect(head).toHaveTextContent("Dokumente1");
    expect(head).toHaveTextContent("Chunks3");
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Dokumente" })).queryByText(NOTE)).toBeNull());
    fireEvent.click(within(head).getByRole("button", { name: "Alle Quellen" }));
    expect(await screen.findByRole("button", { name: "Notiz" })).toBeInTheDocument();
  });

  it("opens a document from its row: metadata, full text and numbered chunks", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "guide/intro.md" }).closest("tr")!);
    const doc = await screen.findByRole("region", { name: "Dokument" });
    expect(calls.some((c) => c.url === "/bff/knowledge/rag/documents/docs%3Aguide/intro.md")).toBe(true);
    const meta = await within(doc).findByLabelText("Metadaten");
    expect(meta).toHaveTextContent("Quelledocs");
    expect(meta).toHaveTextContent("Kennungdocs:guide/intro.md");
    expect(meta).toHaveTextContent("Pfadguide/intro.md");
    expect(within(doc).getByLabelText("Volltext")).toHaveTextContent("Erster Absatz der Einleitung.");
    expect(within(doc).getByLabelText("Volltext")).toHaveTextContent("Dritter Absatz.");
    fireEvent.click(within(doc).getByRole("button", { name: "Chunks (3)" }));
    const items = within(within(doc).getByRole("list", { name: "Chunks" })).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[1]).toHaveTextContent("Chunk 2 von 3");
    fireEvent.click(within(doc).getByRole("button", { name: "Zurück zur Übersicht" }));
    expect(await screen.findByLabelText("Wissen durchsuchen")).toBeInTheDocument();
  });

  it("edits a document: loads the full text into the editor, saves under the same id and shows the new text", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Notiz" }));
    const doc = await screen.findByRole("region", { name: "Dokument" });
    await within(doc).findByLabelText("Volltext");
    fireEvent.click(within(doc).getByRole("button", { name: "Dokument bearbeiten" }));
    const editor = within(doc).getByRole("form", { name: "Dokument bearbeiten" });
    const area = within(editor).getByLabelText("Inhalt");
    expect(area).toHaveValue("Eine kurze Notiz.");
    expect(within(editor).getByText(/Etwa 1 Chunks/)).toBeInTheDocument();
    expect(within(editor).queryByText(/Repository-Sync/)).toBeNull();  // manuelles Dokument: keine Sync-Warnung
    fireEvent.change(area, { target: { value: "Die geänderte Notiz." } });
    fireEvent.change(within(editor).getByLabelText("Titel"), { target: { value: "Notiz 2" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Speichern" }));
    expect(await within(doc).findByText("Gespeichert: 1 Chunks, 3 alte entfernt.")).toBeInTheDocument();
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("/bff/knowledge/rag/documents/manual%3Anotiz");
    expect(put.body).toEqual({ text: "Die geänderte Notiz.", title: "Notiz 2" });
    expect(await within(doc).findByLabelText("Volltext")).toHaveTextContent("Die geänderte Notiz.");
  });

  it("warns that repository documents may be overwritten by the next sync", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "guide/intro.md" }));
    const doc = await screen.findByRole("region", { name: "Dokument" });
    await within(doc).findByLabelText("Volltext");
    fireEvent.click(within(doc).getByRole("button", { name: "Dokument bearbeiten" }));
    expect(within(doc).getByText(/Der nächste Sync kann deine Änderung überschreiben/)).toBeInTheDocument();
  });

  it("keeps the editor and shows the reason when saving fails, and asks for a fresh login when needed", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Notiz" }));
    const doc = await screen.findByRole("region", { name: "Dokument" });
    await within(doc).findByLabelText("Volltext");
    fireEvent.click(within(doc).getByRole("button", { name: "Dokument bearbeiten" }));
    fireEvent.change(within(doc).getByLabelText("Inhalt"), { target: { value: "neu" } });
    failPut = { status: 502, body: { detail: "Die neue Fassung ist nicht in der Datenbank angekommen. Das alte Dokument bleibt unverändert." } };
    fireEvent.click(within(doc).getByRole("button", { name: "Speichern" }));
    expect(await within(doc).findByRole("alert")).toHaveTextContent("bleibt unverändert");
    expect(within(doc).getByLabelText("Inhalt")).toHaveValue("neu");
    failPut = { status: 401, body: { detail: { code: "step_up_required", message: "Bitte erneut anmelden" } } };
    fireEvent.click(within(doc).getByRole("button", { name: "Speichern" }));
    expect(await within(doc).findByRole("button", { name: "Erneut anmelden" })).toBeInTheDocument();
    fireEvent.click(within(doc).getByRole("button", { name: "Abbrechen" }));
    expect(within(doc).queryByRole("form")).toBeNull();
  });

  it("opens a search hit at the matching chunk, with score and a filter by source", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Wissen durchsuchen"), { target: { value: "Marzipan" } });
    fireEvent.click(screen.getByRole("button", { name: "Suchen" }));
    const hits = await screen.findAllByRole("listitem");
    expect(within(hits[0]).getByLabelText("Score 0,81")).toBeInTheDocument();
    expect(within(hits[1]).queryByRole("button", { name: "Dokument öffnen" })).toBeNull();  // ohne Kennung nicht öffenbar
    fireEvent.click(within(hits[0]).getByRole("button", { name: "Dokument öffnen" }));
    const doc = await screen.findByRole("region", { name: "Dokument" });
    const items = await within(doc).findAllByRole("listitem");
    expect(items[1]).toHaveAttribute("aria-current", "true");
    expect(items[1]).toHaveTextContent("Fundstelle");
    expect(items[0]).not.toHaveAttribute("aria-current");
  });

  it("loads a .md file into the ingest form, takes the title from the file name and sends the chosen source", async () => {
    await open();
    fireEvent.click(screen.getByText("Text einspeisen"));
    const file = new File(["# Überschrift\n\nInhalt"], "meine-notiz.md", { type: "text/markdown" });
    fireEvent.change(screen.getByLabelText("Textdatei laden"), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByLabelText("Text")).toHaveValue("# Überschrift\n\nInhalt"));
    expect(screen.getByLabelText("Titel")).toHaveValue("meine-notiz");
    expect(screen.getByText(/Etwa 1 Chunks/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Quelle zum Einspeisen"), { target: { value: "docs" } });
    fireEvent.click(screen.getByRole("button", { name: "Einspeisen" }));
    expect(await screen.findByText("Eingespeist als manual:neu.")).toBeInTheDocument();
    expect(calls.find((c) => c.url.endsWith("/ingest"))!.body).toEqual({ title: "meine-notiz", text: "# Überschrift\n\nInhalt", source: "docs" });
  });

  it("offers a new source name and rejects wrong or too large files with a reason", async () => {
    await open();
    fireEvent.click(screen.getByText("Text einspeisen"));
    fireEvent.change(screen.getByLabelText("Titel"), { target: { value: "T" } });
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Quelle zum Einspeisen"), { target: { value: "\u0000neu" } });
    const send = screen.getByRole("button", { name: "Einspeisen" });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Name der neuen Quelle"), { target: { value: "wiki" } });
    fireEvent.click(send);
    await waitFor(() => expect(calls.find((c) => c.url.endsWith("/ingest"))?.body).toEqual({ title: "T", text: "x", source: "wiki" }));
    fireEvent.change(screen.getByLabelText("Textdatei laden"), { target: { files: [new File(["x"], "bild.pdf")] } });
    expect(await screen.findByText(/Nur Dateien mit der Endung \.md oder \.txt/)).toBeInTheDocument();
    const big = new File(["x"], "gross.txt");
    Object.defineProperty(big, "size", { value: 1_048_577 });
    fireEvent.change(screen.getByLabelText("Textdatei laden"), { target: { files: [big] } });
    expect(await screen.findByText(/höchstens 1\.048\.576 \(1 MiB\)/)).toBeInTheDocument();
  });

  it("shows why a document cannot be opened", async () => {
    await open();
    delete docs[INTRO];
    fireEvent.click(screen.getByRole("button", { name: "guide/intro.md" }));
    expect(await screen.findByText(/Dokument nicht ladbar: Dokument nicht gefunden/)).toBeInTheDocument();
  });
});
