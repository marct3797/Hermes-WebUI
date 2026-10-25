import { useState } from "react";
import { diffFor, type Git, type GitCommit } from "../../filesApi";
import { t } from "../../i18n";

const LIMIT = 65536;
const STATE: Record<string, string> = { M: "geändert", A: "neu", D: "gelöscht", R: "umbenannt", get "??"() { return t("nicht verfolgt"); }, MM: "geändert", get AM() { return t("neu, geändert"); } };
type View = "changes" | "log" | "branches";

export function GitPanel({ git, error, onRefresh, onOpenFile }: { git?: Git; error?: string; onRefresh: () => void; onOpenFile: (path: string) => void }) {
  const [view, setView] = useState<View>("changes");
  const [file, setFile] = useState<string>();
  const [commit, setCommit] = useState<GitCommit>();
  const head = <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
    <h2>{t("Git · {branch}", { branch: git?.branch || t("Arbeitsordner") })}</h2>
    <button type="button" className="btn btn-s btn-g" onClick={onRefresh}>{t("Git aktualisieren")}</button>
  </div>;
  if (error) return <section className="workspace-git" aria-label={t("Git")}>{head}<p role="alert">{error}</p></section>;
  if (!git) return <section className="workspace-git" aria-label={t("Git")}>{head}<p role="status">{t("Lade Git…")}</p></section>;
  if (git.repository === false) return <section className="workspace-git" aria-label={t("Git")}>{head}
    <p className="muted" role="status">{git.reason ?? t("Kein Git-Repository in diesem Arbeitsordner")}{t(". Mit")} <code>git init</code> {t("im Terminal wird der Ordner zum Repository.")}</p></section>;
  const changed = git.files ?? [];
  const diff = file ? diffFor(git.diff, file) : git.diff;
  const state = changed.find((f) => f.path === file)?.state;
  const tabs: [View, string][] = [["changes", t("Änderungen ({length})", { length: changed.length })], ["log", `Verlauf (${git.log?.length ?? 0})`], ["branches", `Branches (${git.branches?.length ?? 0})`]];
  return <section className="workspace-git" aria-label={t("Git")}>{head}
    <div className="tabs" role="group" aria-label={t("Git-Ansichten")}>{tabs.map(([id, label]) => <button type="button" key={id} className={`tab${view === id ? " on" : ""}`} aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>)}</div>
    {view === "changes" && <div className="git-split">
      <ul className="git-list" aria-label={t("Geänderte Dateien")}>
        {changed.length === 0 && <li className="muted">{t("Keine Änderungen.")}</li>}
        {changed.length > 0 && <li><button type="button" className={`ft-row${file === undefined ? " on" : ""}`} onClick={() => setFile(undefined)}>{t("Alle Änderungen")}</button></li>}
        {changed.map((f) => <li key={f.path}><button type="button" className={`ft-row${file === f.path ? " on" : ""}`} onClick={() => setFile(f.path)}>
          <span className="git-state mono">{f.state}</span><span>{f.path}</span></button></li>)}
      </ul>
      <div className="git-diff">
        {file && <p className="row" style={{ gap: 8 }}><strong className="mono">{file}</strong> <span className="muted">{STATE[state ?? ""] ?? state}</span>
          {state !== "D" && <button type="button" className="btn btn-s btn-g" onClick={() => onOpenFile(file)}>{t("Im Editor öffnen")}</button>}</p>}
        {diff ? <pre aria-label={t("Git Diff")}>{diff.slice(0, LIMIT)}</pre> : <p className="muted" role="status">{file ? (state === "??" ? t("Neue, noch nicht verfolgte Datei: kein Diff.") : t("Kein Diff verfügbar (gekürzt oder nicht lesbar).")) : t("Kein Diff.")}</p>}
        {(git.truncated || diff.length > LIMIT) && <p role="status">{t("Git-Ausgabe gekürzt.")}</p>}
      </div>
    </div>}
    {view === "log" && <div className="git-split">
      <ul className="git-list" aria-label={t("Commit-Verlauf")}>
        {!git.log?.length && <li className="muted">{t("Noch keine Commits.")}</li>}
        {git.log?.map((c) => <li key={c.hash}><button type="button" className={`ft-row${commit?.hash === c.hash ? " on" : ""}`} onClick={() => setCommit(c)}>
          <span className="git-state mono">{c.hash.slice(0, 7)}</span><span>{c.subject}</span></button></li>)}
      </ul>
      <div className="git-diff">{commit ? <dl aria-label={t("Commit-Details")}><dt>{t("Titel")}</dt><dd>{commit.subject}</dd><dt>{t("Autor")}</dt><dd>{commit.author}</dd>
        <dt>{t("Datum")}</dt><dd>{new Date(commit.date).toLocaleString("de-DE")}</dd><dt>{t("Hash")}</dt><dd className="mono">{commit.hash}</dd></dl> : <p className="muted">{t("Commit auswählen.")}</p>}</div>
    </div>}
    {view === "branches" && <ul aria-label={t("Branches")}>{git.branches?.map((b) => <li key={b.name}>{b.name}{b.current && <span className="muted"> {t("· aktuell")}</span>}</li>)}
      {!git.branches?.length && <li className="muted">{t("Keine Branches.")}</li>}</ul>}
    {git.remotes?.length > 0 && <p className="muted">{t("Remotes:")} {git.remotes.map((r) => <span className="mono" key={r.name}>{r.name} {r.url} </span>)}</p>}
  </section>;
}
