import { useEffect, useRef, useState } from "react";
import "../styles/workspace.css";

type Workspace = { id: string; label: string };
type Entry = { name: string; path: string; kind: "directory" | "file"; size?: number };
type Files = { entries?: Entry[]; content?: string; truncated?: boolean; mime?: string };
type Git = { repository?: boolean; reason?: string;  branch: string; status: string; diff: string; remotes: { name: string; url: string }[]; truncated?: boolean };
const PREVIEW_LIMIT = 65536;

async function request<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", signal,
    headers: { "X-Requested-With": "hermes-webui", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`Anfrage fehlgeschlagen (${response.status})${response.status === 401 || response.status === 403 ? "; ggf. frisch anmelden" : ""}.`);
  return response.json();
}

function encodedFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Datei nicht lesbar"));
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(file);
  });
}

export function WorkspacePage({ host, initialWorkspace }: { host: string; initialWorkspace?: string }) {
  const base = `/bff/h/${encodeURIComponent(host)}`;
  const [workspaces, setWorkspaces] = useState<Workspace[]>();
  const [workspace, setWorkspace] = useState("");
  const [directory, setDirectory] = useState("");
  const [entries, setEntries] = useState<Entry[]>();
  const [selected, setSelected] = useState<string>();
  const [preview, setPreview] = useState<Files>();
  const [git, setGit] = useState<Git>();
  const [error, setError] = useState<string>();
  const [gitError, setGitError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [uploading, setUploading] = useState(false);
  const [revision, setRevision] = useState(0);
  const previewRequest = useRef(0);
  const scope = useRef(0);
  const query = (path: string) => new URLSearchParams({ workspace, path }).toString();

  useEffect(() => {
    const controller = new AbortController();
    setWorkspaces(undefined); setWorkspace(""); setError(undefined);
    request<{ workspaces: Workspace[] }>(`${base}/_workspaces`, undefined, controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      setWorkspaces(data.workspaces);
      setWorkspace(data.workspaces.find((w) => w.id === initialWorkspace)?.id ?? data.workspaces[0]?.id ?? "");
    }).catch((e: Error) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [base, initialWorkspace]);

  useEffect(() => {
    scope.current++; previewRequest.current++;
    setDirectory(""); setSelected(undefined); setPreview(undefined); setNotice(undefined);
    return () => { scope.current++; previewRequest.current++; };
  }, [base, workspace]);

  useEffect(() => {
    const controller = new AbortController();
    setGit(undefined); setGitError(undefined);
    if (workspace) request<Git>(`${base}/_git?${new URLSearchParams({ workspace })}`, undefined, controller.signal)
      .then((data) => { if (!controller.signal.aborted) setGit(data); }).catch((e: Error) => { if (!controller.signal.aborted) setGitError(e.message); });
    return () => controller.abort();
  }, [base, workspace, revision]);

  useEffect(() => {
    const controller = new AbortController();
    setEntries(undefined); setError(undefined);
    if (workspace) request<Files>(`${base}/_files?${new URLSearchParams({ workspace, path: directory })}`, undefined, controller.signal)
      .then((data) => { if (!controller.signal.aborted) setEntries(data.entries ?? []); }).catch((e: Error) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [base, workspace, directory, revision]);

  const open = async (entry: Entry) => {
    previewRequest.current++;
    if (entry.kind === "directory") { setDirectory(entry.path); setSelected(undefined); setPreview(undefined); return; }
    const id = previewRequest.current;
    setSelected(entry.path); setPreview(undefined); setError(undefined);
    // PDF and other binary content is attachment-only, never embedded active content.
    if (/\.(pdf|png|jpe?g|gif|webp|zip|gz|woff2?|exe|bin)$/i.test(entry.name)) { setPreview({ mime: "application/octet-stream" }); return; }
    try {
      const data = await request<Files>(`${base}/_files?${query(entry.path)}`);
      if (id !== previewRequest.current) return;
      setPreview({ ...data, content: data.content?.slice(0, PREVIEW_LIMIT), truncated: data.truncated || (data.content?.length ?? 0) > PREVIEW_LIMIT });
    } catch (e) { if (id === previewRequest.current) setError(`${(e as Error).message} Binärdateien nur herunterladen.`); }
  };

  const upload = async (file?: File) => {
    if (!file || uploading) return;
    setError(undefined); setNotice(undefined);
    if (file.size > 1048576) { setError("Maximal 1 MiB pro Datei."); return; }
    if (!file.name || /[\\/]/.test(file.name)) { setError("Ungültiger Dateiname."); return; }
    const currentScope = scope.current;
    setUploading(true);
    try {
      const content_base64 = await encodedFile(file);
      if (currentScope !== scope.current) return;
      await request(`${base}/_files/upload`, { workspace, path: directory ? `${directory}/${file.name}` : file.name, content_base64 });
      if (currentScope !== scope.current) return;
      setRevision((n) => n + 1);
      setNotice("Datei hochgeladen. Bestehende Dateien werden nicht überschrieben.");
    } catch (e) { if (currentScope === scope.current) setError((e as Error).message); }
    finally { setUploading(false); }
  };

  return <main className="page workspace-page">
    <header className="workspace-toolbar"><div><h1>Workspace</h1><p className="muted">{host} · Nur freigegebene Arbeitsordner</p></div>
      <label>Arbeitsordner <select className="field" value={workspace} onChange={(e) => setWorkspace(e.target.value)} disabled={!workspaces?.length}>
        <option value="" disabled>Arbeitsordner wählen</option>{workspaces?.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
      </select></label>
      <label className="btn btn-s">{uploading ? "Lade hoch…" : "Datei hochladen"}<input aria-label="Datei hochladen" type="file" disabled={!workspace || uploading} onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} /></label>
    </header>
    {error && <p className="banner" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!workspaces && !error && <p role="status">Lade Arbeitsordner…</p>}
    {workspaces?.length === 0 && <p role="status">Keine Arbeitsordner eingerichtet.</p>}
    {workspace && <div className="workspace-grid">
      <section className="workspace-files" aria-label="Dateien"><h2>Dateien</h2><p className="mono">/{directory}</p>
        {directory && <button className="btn btn-s btn-g" onClick={() => { setDirectory(directory.split("/").slice(0, -1).join("/")); setSelected(undefined); previewRequest.current++; }}>Übergeordneter Ordner</button>}
        {!entries ? <p role="status">Lade Dateien…</p> : entries.length === 0 ? <p className="muted">Dieser Arbeitsordner ist leer.</p> : <ul>{entries.map((entry) => <li key={entry.path}><button className="btn btn-g" onClick={() => void open(entry)}>{entry.name}{entry.kind === "directory" ? "/" : ""}</button></li>)}</ul>}
      </section>
      <section className="workspace-preview" aria-label="Dateivorschau"><h2>{selected ?? "Vorschau"}</h2>
        {selected ? <><a className="inline-link" href={`${base}/_files/download?${query(selected)}`} download>Datei herunterladen</a>
          {preview?.content !== undefined ? <pre aria-label="Textvorschau">{preview.content}</pre> : <p className="muted">{preview ? "Keine Textvorschau. Datei sicher herunterladen." : "Lade Textvorschau…"}</p>}
          {preview?.truncated && <p role="status">Vorschau gekürzt (maximal 64 KiB).</p>}</> : <p className="muted">Datei auswählen. PDF und Binärdateien werden nur heruntergeladen.</p>}
      </section>
      <section className="workspace-git" aria-label="Git"><h2>Git · {git?.branch ?? "Arbeitsordner"}</h2>
        {gitError ? <p role="alert">{gitError}</p> : !git ? <p role="status">Lade Git…</p> : git.repository === false ? <p className="muted" role="status">{git.reason ?? "Kein Git-Repository in diesem Arbeitsordner"}</p> : <><pre aria-label="Git Status">{git.status || "Keine Änderungen."}</pre><pre aria-label="Git Diff">{git.diff?.slice(0, PREVIEW_LIMIT) || "Kein Diff."}</pre>{(git.truncated || git.diff?.length > PREVIEW_LIMIT) && <p role="status">Git-Ausgabe gekürzt.</p>}{git.remotes?.map((remote) => <p className="mono" key={remote.name}>{remote.name}: {remote.url}</p>)}</>}
      </section>
    </div>}
  </main>;
}
