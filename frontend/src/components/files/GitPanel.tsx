import { useState } from "react";
import { diffFor, type Git, type GitCommit } from "../../filesApi";

const LIMIT = 65536;
const STATE: Record<string, string> = { M: "geändert", A: "neu", D: "gelöscht", R: "umbenannt", "??": "nicht verfolgt", MM: "geändert", AM: "neu, geändert" };
type View = "changes" | "log" | "branches";

export function GitPanel({ git, error, onRefresh, onOpenFile }: { git?: Git; error?: string; onRefresh: () => void; onOpenFile: (path: string) => void }) {
  const [view, setView] = useState<View>("changes");
  const [file, setFile] = useState<string>();
  const [commit, setCommit] = useState<GitCommit>();
  const head = <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
    <h2>Git · {git?.branch || "Arbeitsordner"}</h2>
    <button type="button" className="btn btn-s btn-g" onClick={onRefresh}>Git aktualisieren</button>
  </div>;
  if (error) return <section className="workspace-git" aria-label="Git">{head}<p role="alert">{error}</p></section>;
  if (!git) return <section className="workspace-git" aria-label="Git">{head}<p role="status">Lade Git…</p></section>;
  if (git.repository === false) return <section className="workspace-git" aria-label="Git">{head}
    <p className="muted" role="status">{git.reason ?? "Kein Git-Repository in diesem Arbeitsordner"}. Mit <code>git init</code> im Terminal wird der Ordner zum Repository.</p></section>;
  const changed = git.files ?? [];
  const diff = file ? diffFor(git.diff, file) : git.diff;
  const state = changed.find((f) => f.path === file)?.state;
  const tabs: [View, string][] = [["changes", `Änderungen (${changed.length})`], ["log", `Verlauf (${git.log?.length ?? 0})`], ["branches", `Branches (${git.branches?.length ?? 0})`]];
  return <section className="workspace-git" aria-label="Git">{head}
    <div className="tabs" role="group" aria-label="Git-Ansichten">{tabs.map(([id, label]) => <button type="button" key={id} className={`tab${view === id ? " on" : ""}`} aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>)}</div>
    {view === "changes" && <div className="git-split">
      <ul className="git-list" aria-label="Geänderte Dateien">
        {changed.length === 0 && <li className="muted">Keine Änderungen.</li>}
        {changed.length > 0 && <li><button type="button" className={`ft-row${file === undefined ? " on" : ""}`} onClick={() => setFile(undefined)}>Alle Änderungen</button></li>}
        {changed.map((f) => <li key={f.path}><button type="button" className={`ft-row${file === f.path ? " on" : ""}`} onClick={() => setFile(f.path)}>
          <span className="git-state mono">{f.state}</span><span>{f.path}</span></button></li>)}
      </ul>
      <div className="git-diff">
        {file && <p className="row" style={{ gap: 8 }}><strong className="mono">{file}</strong> <span className="muted">{STATE[state ?? ""] ?? state}</span>
          {state !== "D" && <button type="button" className="btn btn-s btn-g" onClick={() => onOpenFile(file)}>Im Editor öffnen</button>}</p>}
        {diff ? <pre aria-label="Git Diff">{diff.slice(0, LIMIT)}</pre> : <p className="muted" role="status">{file ? (state === "??" ? "Neue, noch nicht verfolgte Datei: kein Diff." : "Kein Diff verfügbar (gekürzt oder nicht lesbar).") : "Kein Diff."}</p>}
        {(git.truncated || diff.length > LIMIT) && <p role="status">Git-Ausgabe gekürzt.</p>}
      </div>
    </div>}
    {view === "log" && <div className="git-split">
      <ul className="git-list" aria-label="Commit-Verlauf">
        {!git.log?.length && <li className="muted">Noch keine Commits.</li>}
        {git.log?.map((c) => <li key={c.hash}><button type="button" className={`ft-row${commit?.hash === c.hash ? " on" : ""}`} onClick={() => setCommit(c)}>
          <span className="git-state mono">{c.hash.slice(0, 7)}</span><span>{c.subject}</span></button></li>)}
      </ul>
      <div className="git-diff">{commit ? <dl aria-label="Commit-Details"><dt>Titel</dt><dd>{commit.subject}</dd><dt>Autor</dt><dd>{commit.author}</dd>
        <dt>Datum</dt><dd>{new Date(commit.date).toLocaleString("de-DE")}</dd><dt>Hash</dt><dd className="mono">{commit.hash}</dd></dl> : <p className="muted">Commit auswählen.</p>}</div>
    </div>}
    {view === "branches" && <ul aria-label="Branches">{git.branches?.map((b) => <li key={b.name}>{b.name}{b.current && <span className="muted"> · aktuell</span>}</li>)}
      {!git.branches?.length && <li className="muted">Keine Branches.</li>}</ul>}
    {git.remotes?.length > 0 && <p className="muted">Remotes: {git.remotes.map((r) => <span className="mono" key={r.name}>{r.name} {r.url} </span>)}</p>}
  </section>;
}
