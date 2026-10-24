import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WorkspacePage } from "./WorkspacePage";

type Store = { files: Record<string, string>; dirs: Set<string>; conflictOnce?: boolean; git: unknown; workspaces: unknown[]; calls: { method: string; url: string; body?: any }[] };
const sha = (text: string) => `sha:${text}`.padEnd(64, "0");
let store: Store;
const json = (data: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => data });

function fake() {
  store = {
    files: { "README.md": "hallo\nwelt\n", "src/main.py": "print(1)\n", "paper.pdf": "%PDF" }, dirs: new Set(["src", "leer"]), calls: [],
    workspaces: [{ id: "repo", label: "Repo", is_git: true }, { id: "leer", label: "Leer", is_git: false }],
    git: { branch: "main", status: " M README.md", diff: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-alt\n+neu\n",
      files: [{ path: "README.md", state: "M" }, { path: "neu.txt", state: "??" }],
      log: [{ hash: "a".repeat(40), subject: "Erster Stand", author: "Alpha", date: "2026-01-01T10:00:00+00:00" }],
      branches: [{ name: "main", current: true }, { name: "feature", current: false }], remotes: [], truncated: false },
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, opts?: RequestInit) => {
    const u = new URL(url, "http://x"); const method = opts?.method ?? "GET"; const body = opts?.body ? JSON.parse(String(opts.body)) : undefined;
    store.calls.push({ method, url, body });
    const ws = u.searchParams.get("workspace"); const path = u.searchParams.get("path") ?? "";
    if (u.pathname.endsWith("_workspaces")) return json({ workspaces: store.workspaces });
    if (u.pathname.endsWith("_git")) return json(ws === "leer" ? { repository: false, reason: "Kein Git-Repository in diesem Arbeitsordner" } : store.git);
    if (u.pathname.endsWith("_files") && method === "GET") {
      if (ws === "leer") return json({ entries: [] });
      if (path === "" || store.dirs.has(path)) {
        const prefix = path ? `${path}/` : "";
        const names = new Map<string, boolean>();
        for (const f of Object.keys(store.files)) if (f.startsWith(prefix)) names.set(f.slice(prefix.length).split("/")[0], f.slice(prefix.length).includes("/"));
        for (const d of store.dirs) if (d.startsWith(prefix) && d !== path && !d.slice(prefix.length).includes("/")) names.set(d.slice(prefix.length), true);
        return json({ entries: [...names].sort().map(([name, dir]) => ({ name, path: prefix + name, kind: dir ? "directory" : "file", size: 1 })) });
      }
      if (!(path in store.files)) return json({ detail: "Datei oder Ordner nicht gefunden" }, 404);
      return json({ content: store.files[path], sha256: sha(store.files[path]), size: store.files[path].length, editable: true, truncated: false });
    }
    if (u.pathname.endsWith("/write")) {
      if (body.create && body.path in store.files) return json({ detail: "Konflikt" }, 409);
      if (!body.create && (store.conflictOnce || body.expected_sha256 !== sha(store.files[body.path]))) { store.conflictOnce = false; return json({ detail: "Konflikt: Ziel existiert oder die Datei hat sich geändert" }, 409); }
      store.files[body.path] = body.content; return json({ sha256: sha(body.content), size: body.content.length });
    }
    if (u.pathname.endsWith("/mkdir")) { if (store.dirs.has(body.path)) return json({ detail: "Konflikt" }, 409); store.dirs.add(body.path); return json({ ok: true }); }
    if (u.pathname.endsWith("/move")) {
      if (body.to in store.files) return json({ detail: "Konflikt" }, 409);
      if (body.from in store.files) { store.files[body.to] = store.files[body.from]; delete store.files[body.from]; }
      return json({ ok: true });
    }
    if (u.pathname.endsWith("/upload")) { store.files[body.path] = "binary"; return json({ ok: true }); }
    return json({ detail: "unbekannt" }, 404);
  }));
}
const renderPage = () => render(<WorkspacePage host="laptop" initialWorkspace="repo" />);
const writes = () => store.calls.filter((c) => c.method !== "GET");

beforeEach(() => { fake(); history.replaceState(null, "", "/hosts/laptop/workspace"); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Workspace Dateibaum", () => {
  it("lädt Ordner beim Aufklappen und klappt wieder zu", async () => {
    renderPage();
    expect(await screen.findByRole("button", { name: "README.md" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "main.py" })).toBeNull();
    const src = screen.getByRole("button", { name: "src/" });
    expect(src).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(src);
    expect(await screen.findByRole("button", { name: "main.py" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "src/" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "src/" }));
    expect(screen.queryByRole("button", { name: "main.py" })).toBeNull();
    expect(store.calls.filter((c) => c.url.includes("path=src")).length).toBe(1);
  });

  it("zeigt leeren Arbeitsordner mit Handlungshinweis und merkt die Auswahl in der URL", async () => {
    render(<WorkspacePage host="laptop" initialWorkspace="leer" />);
    expect(await screen.findByText(/Dieser Arbeitsordner ist leer/)).toBeInTheDocument();
    expect(screen.getByText(/Neue Datei“ oder „Neuer Ordner/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Neue Datei" })).toBeEnabled();
    expect(screen.getByText(/python -m hostd.workspaces add/)).toBeInTheDocument();
    expect(await screen.findByText(/Kein Git-Repository/)).toBeInTheDocument();
    expect(location.search).toBe("?ws=leer");
  });

  it("meldet ehrlich, wenn kein Arbeitsordner konfiguriert ist", async () => {
    fake(); store.workspaces = [];
    renderPage();
    expect(await screen.findByText("Keine Arbeitsordner eingerichtet.")).toBeInTheDocument();
    expect(screen.getByText(/python -m hostd.workspaces add/)).toBeInTheDocument();
  });
});

describe("Workspace Editor", () => {
  it("öffnet, bearbeitet und speichert mit sha-Prüfung", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
    const area = await screen.findByLabelText("Inhalt von README.md");
    expect(area).toHaveValue("hallo\nwelt\n");
    expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();
    fireEvent.change(area, { target: { value: "hallo\nneue welt\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(store.files["README.md"]).toBe("hallo\nneue welt\n"));
    const write = writes().find((c) => c.url.endsWith("/write"))!;
    expect(write.method).toBe("PUT");
    expect(write.body).toEqual({ workspace: "repo", path: "README.md", content: "hallo\nneue welt\n", expected_sha256: sha("hallo\nwelt\n") });
    expect(await screen.findByText(/Gespeichert/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();
    expect(location.search).toContain("file=README.md");
  });

  it("zeigt bei 409 den Konflikt-Dialog: Neu laden verwirft den Entwurf", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
    const area = await screen.findByLabelText("Inhalt von README.md");
    fireEvent.change(area, { target: { value: "meine fassung" } });
    store.files["README.md"] = "fremd geändert"; // jemand anderes schreibt
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    const dialog = await screen.findByRole("dialog", { name: "Datei hat sich geändert" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Neu laden" }));
    await waitFor(() => expect(screen.getByLabelText("Inhalt von README.md")).toHaveValue("fremd geändert"));
    expect(store.files["README.md"]).toBe("fremd geändert");
  });

  it("Meine Fassung behalten: Entwurf bleibt und überschreibt beim nächsten Speichern", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
    const area = await screen.findByLabelText("Inhalt von README.md");
    fireEvent.change(area, { target: { value: "meine fassung" } });
    store.files["README.md"] = "fremd";
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Datei hat sich geändert" })).getByRole("button", { name: "Meine Fassung behalten" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByLabelText("Inhalt von README.md")).toHaveValue("meine fassung");
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(store.files["README.md"]).toBe("meine fassung"));
  });

  it("warnt bei ungespeicherten Änderungen vor dem Wechsel der Datei", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
    fireEvent.change(await screen.findByLabelText("Inhalt von README.md"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "src/" }));
    fireEvent.click(await screen.findByRole("button", { name: "main.py" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Inhalt von README.md")).toHaveValue("x");
    fireEvent.click(screen.getByRole("button", { name: "main.py" }));
    expect(await screen.findByLabelText("Inhalt von src/main.py")).toHaveValue("print(1)\n");
  });

  it("öffnet PDF nur als Download, nie als Text", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "paper.pdf" }));
    const link = await screen.findByRole("link", { name: "Herunterladen" });
    expect(link.getAttribute("href")).toBe("/bff/h/laptop/_files/download?workspace=repo&path=paper.pdf");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(store.calls.some((c) => c.url.includes("path=paper.pdf") && !c.url.includes("download"))).toBe(false);
  });
});

describe("Workspace Anlegen, Umbenennen, Hochladen", () => {
  it("legt Datei und Ordner im gewählten Ordner an und öffnet die neue Datei", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "src/" }));
    fireEvent.click(screen.getByRole("button", { name: "Neuer Ordner" }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "lib" } });
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    await waitFor(() => expect(store.dirs.has("src/lib")).toBe(true));
    fireEvent.click(await screen.findByRole("button", { name: "Neue Datei" }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "notiz.txt" } });
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    await waitFor(() => expect(store.files["src/notiz.txt"]).toBe(""));
    expect(await screen.findByLabelText("Inhalt von src/notiz.txt")).toHaveValue("");
    expect(writes().find((c) => c.url.endsWith("/write"))!.body).toMatchObject({ create: true, path: "src/notiz.txt" });
    expect(await screen.findByRole("button", { name: "lib/" })).toBeInTheDocument();
  });

  it("lehnt ungültige Namen ohne Anfrage ab und zeigt Konflikte des Hosts", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Neue Datei" }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "../x" } });
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Ungültiger Name");
    expect(writes()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "README.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Konflikt"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("benennt eine Datei um und folgt mit dem Editor", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
    await screen.findByLabelText("Inhalt von README.md");
    fireEvent.click(screen.getByRole("button", { name: "Umbenennen/Verschieben" }));
    fireEvent.change(screen.getByLabelText("Neuer Pfad im Arbeitsordner"), { target: { value: "LIESMICH.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Verschieben" }));
    await waitFor(() => expect(store.files["LIESMICH.md"]).toBe("hallo\nwelt\n"));
    expect(writes().find((c) => c.url.endsWith("/move"))!.body).toEqual({ workspace: "repo", from: "README.md", to: "LIESMICH.md" });
    expect(await screen.findByLabelText("Inhalt von LIESMICH.md")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "LIESMICH.md" })).toBeInTheDocument();
  });

  it("lädt in den gewählten Ordner hoch und lehnt zu große Dateien ab", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "src/" }));
    const input = screen.getByLabelText("Datei hochladen");
    fireEvent.change(input, { target: { files: [new File(["%PDF-safe"], "paper2.pdf", { type: "application/pdf" })] } });
    await waitFor(() => expect(store.files["src/paper2.pdf"]).toBe("binary"));
    expect(writes().find((c) => c.url.endsWith("/upload"))!.body).toEqual({ workspace: "repo", path: "src/paper2.pdf", content_base64: btoa("%PDF-safe") });
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(1048577)], "large.pdf")] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("1 MiB");
  });
});

describe("Workspace Git-Panel", () => {
  it("zeigt Branch, geänderte Dateien und den Diff der gewählten Datei", async () => {
    renderPage();
    const panel = await screen.findByRole("region", { name: "Git" });
    expect(await within(panel).findByText("Git · main")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /Änderungen \(2\)/ })).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: /README\.md/ }));
    expect(within(panel).getByLabelText("Git Diff")).toHaveTextContent("+neu");
    expect(within(panel).getByLabelText("Git Diff")).not.toHaveTextContent("neu.txt");
    fireEvent.click(within(panel).getByRole("button", { name: /neu\.txt/ }));
    expect(within(panel).getByText(/noch nicht verfolgte Datei: kein Diff/)).toBeInTheDocument();
  });

  it("öffnet eine geänderte Datei im Editor", async () => {
    renderPage();
    const panel = await screen.findByRole("region", { name: "Git" });
    fireEvent.click(await within(panel).findByRole("button", { name: /README\.md/ }));
    fireEvent.click(within(panel).getByRole("button", { name: "Im Editor öffnen" }));
    expect(await screen.findByLabelText("Inhalt von README.md")).toBeInTheDocument();
  });

  it("zeigt Verlauf mit Commit-Details und die Branches", async () => {
    renderPage();
    const panel = await screen.findByRole("region", { name: "Git" });
    fireEvent.click(await within(panel).findByRole("button", { name: /Verlauf \(1\)/ }));
    fireEvent.click(within(panel).getByRole("button", { name: /Erster Stand/ }));
    const details = within(panel).getByLabelText("Commit-Details");
    expect(details).toHaveTextContent("Alpha");
    expect(details).toHaveTextContent("a".repeat(40));
    fireEvent.click(within(panel).getByRole("button", { name: /Branches \(2\)/ }));
    expect(within(panel).getByText("feature")).toBeInTheDocument();
    expect(within(panel).getByText(/aktuell/)).toBeInTheDocument();
  });

  it("verträgt eine Git-Antwort ohne Details (ältere hostd-Version)", async () => {
    store.git = { branch: "main", status: "", diff: "", remotes: [], truncated: false };
    renderPage();
    const panel = await screen.findByRole("region", { name: "Git" });
    expect(await within(panel).findByText(/Änderungen \(0\)/)).toBeInTheDocument();
    expect(within(panel).getByText("Keine Änderungen.")).toBeInTheDocument();
  });
});
