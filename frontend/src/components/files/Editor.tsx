import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../api";
import { BINARY_RE, EDIT_LIMIT, type HostFiles } from "../../filesApi";
import { Modal } from "./Modal";
import { t } from "../../i18n";

/** Textdatei bearbeiten: Speichern prüft sha256; bei Konflikt entscheidet der Nutzer. Binär und >1 MiB nur Download. */
export function Editor({ files, workspace, path, onDirty, onSaved }: {
  files: HostFiles; workspace: string; path: string; onDirty: (dirty: boolean) => void; onSaved: () => void;
}) {
  const [base, setBase] = useState<{ content: string; sha?: string; editable: boolean; truncated: boolean }>();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();
  const [info, setInfo] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const gutter = useRef<HTMLDivElement>(null);
  const dirty = !!base?.editable && draft !== base.content;

  const load = (keepDraft = false) => {
    setError(undefined);
    if (BINARY_RE.test(path)) { setBase({ content: "", editable: false, truncated: false }); return Promise.resolve(); }
    return files.read(workspace, path).then((data) => {
      const next = { content: data.content ?? "", sha: data.sha256, editable: data.editable !== false && !!data.sha256, truncated: !!data.truncated };
      setBase(next);
      if (!keepDraft) setDraft(next.content);
    }).catch((e: Error) => { setBase({ content: "", editable: false, truncated: false }); setError(e instanceof ApiError && e.status === 415 ? t("Keine Textdatei. Nur Download möglich.") : e.message); });
  };
  useEffect(() => { setBase(undefined); setInfo(undefined); setConflict(false); void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [files, workspace, path]);
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty, onDirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const save = async () => {
    if (!base?.sha || saving) return;
    setSaving(true); setError(undefined); setInfo(undefined);
    try {
      const result = await files.write(workspace, path, draft, base.sha);
      setBase({ ...base, content: draft, sha: result.sha256 });
      setInfo(`Gespeichert (${result.size} Bytes).`); onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(true); else setError((e as Error).message);
    } finally { setSaving(false); }
  };
  // „Meine Fassung behalten“: aktuelle Fassung der Platte als neue Basis, der Entwurf bleibt und überschreibt beim nächsten Speichern.
  const keepMine = async () => { setConflict(false); await load(true); setInfo(t("Meine Fassung bleibt. Beim Speichern wird die fremde Änderung überschrieben.")); };
  const reload = async () => { setConflict(false); await load(); setInfo(t("Neu geladen.")); };

  const lines = draft.split("\n").length;
  return <div className="ed">
    <div className="ed-bar">
      <strong className="mono ed-name">{path}{dirty ? " ●" : ""}</strong>
      <span className="row" style={{ gap: 8 }}>
        <a className="btn btn-s btn-g" href={files.downloadUrl(workspace, path)} download>{t("Herunterladen")}</a>
        {base?.editable && <button type="button" className="btn btn-s" disabled={!dirty || saving} onClick={() => void save()}>{saving ? t("Speichere…") : t("Speichern")}</button>}
      </span>
    </div>
    {error && <p className="banner" role="alert">{error}</p>}
    {info && <p role="status" className="muted">{info}</p>}
    {!base ? <p role="status">{t("Lade Datei…")}</p> : base.editable ? <div className="ed-body">
      <div className="ed-gutter mono" ref={gutter} aria-hidden>{Array.from({ length: lines }, (_, i) => i + 1).join("\n")}</div>
      <textarea className="ed-text mono" aria-label={`Inhalt von ${path}`} spellCheck={false} wrap="off" value={draft}
        onChange={(e) => setDraft(e.target.value)} onScroll={(e) => { if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop; }}
        onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); } }} />
    </div> : <p className="muted">{t("{truncated} Datei herunterladen, um sie zu öffnen.", { truncated: base.truncated ? t("Datei ist größer als {v} MiB und wird nicht bearbeitet.", { v: EDIT_LIMIT / 1048576 }) : t("Keine Textvorschau.") })}</p>}
    {conflict && <Modal label={t("Datei hat sich geändert")} onClose={() => setConflict(false)}>
      <p>{t("Jemand hat diese Datei auf dem Host geändert, seit du sie geöffnet hast. Deine Änderungen sind noch nicht gespeichert.")}</p>
      <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="btn btn-g" onClick={() => void reload()}>{t("Neu laden")}</button>
        <button type="button" className="btn" onClick={() => void keepMine()}>{t("Meine Fassung behalten")}</button>
      </div>
    </Modal>}
  </div>;
}
