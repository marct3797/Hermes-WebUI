import { useCallback, useEffect, useMemo, useState } from "react";
import { Editor } from "../components/files/Editor";
import { FileTree } from "../components/files/FileTree";
import { GitPanel } from "../components/files/GitPanel";
import { Modal } from "../components/files/Modal";
import { hostFiles, joinPath, parentOf, type Entry, type Git, type Workspace } from "../filesApi";
import { useHosts } from "../hosts";
import { navigate } from "../router";
import "../styles/workspace.css";
import "../styles/files.css";
import { t } from "../i18n";

type Dialog = { kind: "file" | "dir" | "move"; value: string; from?: string };
const BAD_NAME = /[\\/\x00-\x1f]|^\.\.?$/;
const encodedFile = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error(t("Datei nicht lesbar")));
  reader.onload = () => resolve(String(reader.result).split(",")[1]);
  reader.readAsDataURL(file);
});

export function WorkspacePage({ host, initialWorkspace }: { host: string; initialWorkspace?: string }) {
  const files = useMemo(() => hostFiles(host), [host]);
  const { hosts } = useHosts();
  const query = new URLSearchParams(location.search);
  const [workspaces, setWorkspaces] = useState<Workspace[]>();
  const [workspace, setWorkspace] = useState("");
  const [cwd, setCwd] = useState("");
  const [focus, setFocus] = useState<string>();
  const [openFile, setOpenFile] = useState<string | undefined>(query.get("file") ?? undefined);
  const [dirty, setDirty] = useState(false);
  const [git, setGit] = useState<Git>();
  const [gitError, setGitError] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [dialog, setDialog] = useState<Dialog>();
  const [dialogError, setDialogError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [gitRevision, setGitRevision] = useState(0);
  const refresh = () => { setRevision((n) => n + 1); setGitRevision((n) => n + 1); };
  const discard = () => !dirty || window.confirm(t("Ungespeicherte Änderungen verwerfen?"));

  useEffect(() => {
    const controller = new AbortController();
    setWorkspaces(undefined); setWorkspace(""); setError(undefined);
    files.workspaces(controller.signal).then((data) => {
      setWorkspaces(data.workspaces);
      const wanted = initialWorkspace ?? new URLSearchParams(location.search).get("ws") ?? "";
      setWorkspace(data.workspaces.find((w) => w.id === wanted)?.id ?? data.workspaces[0]?.id ?? "");
    }).catch((e: Error) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [files, initialWorkspace]);

  useEffect(() => { setCwd(""); setFocus(undefined); setNotice(undefined); }, [files, workspace]);
  useEffect(() => { // Auswahl im URL-Query merken (ohne neuen Verlaufseintrag)
    if (!workspace) return;
    const params = new URLSearchParams({ ws: workspace, ...(openFile ? { file: openFile } : {}) });
    history.replaceState(history.state, "", `${location.pathname}?${params}`);
  }, [workspace, openFile]);
  useEffect(() => {
    const controller = new AbortController();
    setGitError(undefined);
    if (workspace) files.git(workspace, controller.signal).then((data) => setGit(data))
      .catch((e: Error) => { if (!controller.signal.aborted) { setGit(undefined); setGitError(e.message); } });
    return () => controller.abort();
  }, [files, workspace, gitRevision]);

  const open = (entry: Entry) => { if (!discard()) return; setFocus(entry.path); setCwd(parentOf(entry.path)); setOpenFile(entry.path); setError(undefined); };
  const selectDir = (path: string) => { setFocus(path); setCwd(path); };
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setDialogError(undefined);
    try { await action(); setDialog(undefined); } catch (e) { setDialogError((e as Error).message); } finally { setBusy(false); }
  };
  const submit = () => {
    if (!dialog) return;
    const value = dialog.value.trim();
    if (dialog.kind === "move") {
      if (!value || value.split("/").some((p) => !p || BAD_NAME.test(p))) { setDialogError(t("Ungültiger Pfad.")); return; }
      if (value === dialog.from) { setDialog(undefined); return; }
      if (openFile && dirty && (openFile === dialog.from || openFile.startsWith(`${dialog.from}/`)) && !discard()) return;
      void run(async () => {
        await files.move(workspace, dialog.from!, value);
        if (openFile === dialog.from) setOpenFile(value);
        else if (openFile?.startsWith(`${dialog.from}/`)) setOpenFile(undefined);
        setFocus(value); setNotice(`Verschoben nach ${value}.`); refresh();
      });
      return;
    }
    if (!value || BAD_NAME.test(value)) { setDialogError(t("Ungültiger Name: kein Schrägstrich, nicht leer, nicht „.“ oder „..“.")); return; }
    const path = joinPath(cwd, value);
    void run(async () => {
      if (dialog.kind === "dir") { await files.mkdir(workspace, path); setNotice(`Ordner ${path} angelegt.`); }
      else { await files.write(workspace, path, ""); if (!discard()) return; setOpenFile(path); setNotice(`Datei ${path} angelegt.`); }
      refresh();
    });
  };

  const upload = async (file?: File) => {
    if (!file || busy) return;
    setError(undefined); setNotice(undefined);
    if (file.size > 1048576) { setError("Maximal 1 MiB pro Datei."); return; }
    if (!file.name || /[\\/]/.test(file.name)) { setError(t("Ungültiger Dateiname.")); return; }
    setBusy(true);
    try {
      await files.upload(workspace, joinPath(cwd, file.name), await encodedFile(file));
      setNotice(t("Datei hochgeladen. Bestehende Dateien werden nicht überschrieben.")); refresh();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const onDirty = useCallback((value: boolean) => setDirty(value), []);
  const hint = <details className="ws-hint"><summary>{t("Weiteren Arbeitsordner eintragen")}</summary>
    <p>{t("Arbeitsordner stehen in der Konfiguration des Host-Dienstes. Auf dem Host eintragen und den Dienst neu starten:")}</p>
    <pre className="mono">python -m hostd.workspaces add --config ~/.config/hermes-hostd/config.json --id projekt --path /absoluter/pfad --label "Mein Projekt"</pre>
    <p className="muted">{t("Oder beim Installieren:")} <code>deploy/install-hostd.sh --workspace projekt=/absoluter/pfad</code></p></details>;

  return <main className="page workspace-page">
    <header className="workspace-toolbar"><div><h1>{t("Workspace")}</h1><p className="muted">{t("{host} · Nur freigegebene Arbeitsordner", { host })}</p></div>
      {hosts && hosts.length > 1 && <label>{t("Host")} <select className="field" value={host} onChange={(e) => { if (discard()) navigate(`/hosts/${encodeURIComponent(e.target.value)}/workspace`); }}>
        {hosts.map((h) => <option key={h.id} value={h.id}>{h.id}</option>)}</select></label>}
      <label>{t("Arbeitsordner")} <select className="field" value={workspace} onChange={(e) => { if (discard()) { setOpenFile(undefined); setWorkspace(e.target.value); } }} disabled={!workspaces?.length}>
        <option value="" disabled>{t("Arbeitsordner wählen")}</option>{workspaces?.map((w) => <option key={w.id} value={w.id}>{w.label}{w.is_git ? t(" · Git") : ""}</option>)}
      </select></label>
    </header>
    {error && <p className="banner" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!workspaces && !error && <p role="status">{t("Lade Arbeitsordner…")}</p>}
    {workspaces?.length === 0 && <><p role="status">{t("Keine Arbeitsordner eingerichtet.")}</p>{hint}</>}
    {workspace && <div className="workspace-grid">
      <section className="workspace-files" aria-label={t("Dateien")}><h2>{t("Dateien")}</h2>
        <nav className="ft-crumbs mono" aria-label={t("Pfad")}><button type="button" className="btn btn-s btn-g" onClick={() => selectDir("")}>/</button>
          {cwd.split("/").filter(Boolean).map((part, i, all) => <button type="button" className="btn btn-s btn-g" key={i} onClick={() => selectDir(all.slice(0, i + 1).join("/"))}>{part}</button>)}</nav>
        <div className="ft-actions">
          <button type="button" className="btn btn-s" onClick={() => { setDialogError(undefined); setDialog({ kind: "file", value: "" }); }}>{t("Neue Datei")}</button>
          <button type="button" className="btn btn-s" onClick={() => { setDialogError(undefined); setDialog({ kind: "dir", value: "" }); }}>{t("Neuer Ordner")}</button>
          <button type="button" className="btn btn-s btn-g" disabled={!focus} onClick={() => { setDialogError(undefined); setDialog({ kind: "move", value: focus!, from: focus }); }}>{t("Umbenennen/Verschieben")}</button>
          <label className="btn btn-s btn-g">{busy ? t("Bitte warten…") : t("Hochladen")}<input aria-label={t("Datei hochladen")} type="file" disabled={busy} onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} /></label>
          <button type="button" className="btn btn-s btn-g" onClick={refresh}>{t("Aktualisieren")}</button>
        </div>
        <FileTree key={workspace} files={files} workspace={workspace} revision={revision} selected={openFile} cwd={cwd} onOpenFile={open} onSelectDir={selectDir}
          rootEmpty={t("Lege mit „Neue Datei“ oder „Neuer Ordner“ los.")} />
        {hint}
      </section>
      <section className="workspace-preview" aria-label={t("Editor")}>
        {openFile ? <Editor files={files} workspace={workspace} path={openFile} onDirty={onDirty} onSaved={refresh} />
          : <><h2>{t("Editor")}</h2><p className="muted">{t("Datei im Baum auswählen oder mit „Neue Datei“ anlegen. PDF, Bilder und Binärdateien werden nur heruntergeladen.")}</p></>}
      </section>
      <GitPanel git={git} error={gitError} onRefresh={() => setGitRevision((n) => n + 1)} onOpenFile={(path) => open({ name: path.split("/").pop()!, path, kind: "file" })} />
    </div>}
    {dialog && <Modal label={dialog.kind === "file" ? t("Neue Datei") : dialog.kind === "dir" ? t("Neuer Ordner") : "Umbenennen/Verschieben"} busy={busy} onClose={() => setDialog(undefined)}>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="ws-form">
        <label>{dialog.kind === "move" ? t("Neuer Pfad im Arbeitsordner") : `Name (in /${cwd})`}
          <input className="field field-line" autoFocus value={dialog.value} maxLength={200} onChange={(e) => setDialog({ ...dialog, value: e.target.value })} /></label>
        {dialogError && <p className="banner" role="alert">{dialogError}</p>}
        <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-g" disabled={busy} onClick={() => setDialog(undefined)}>{t("Abbrechen")}</button>
          <button type="submit" className="btn" disabled={busy || !dialog.value.trim()}>{dialog.kind === "move" ? t("Verschieben") : t("Anlegen")}</button>
        </div>
      </form>
    </Modal>}
  </main>;
}
