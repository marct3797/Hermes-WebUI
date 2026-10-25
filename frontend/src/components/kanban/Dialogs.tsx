import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, toLogin } from "../../api";
import { Icon } from "../Icon";
import type { BoardMeta, Card } from "../../kanbanApi";
import { t as tr } from "../../i18n";

/** Fehlertext für Schreibaktionen; verlangt der Server eine frische Anmeldung, steht das im Klartext da. */
export const failure = (e: unknown) => (e instanceof ApiError && e.code === "step_up_required" ? "Diese Aktion verlangt eine frische Anmeldung." : e instanceof Error ? e.message : String(e));
export const needsLogin = (e: unknown) => e instanceof ApiError && e.code === "step_up_required";

export function Banner({ error }: { error?: string | unknown }) {
  if (!error) return null;
  const login = needsLogin(error);
  return <p className="banner" role="alert"><Icon name="alert" /><span>{typeof error === "string" ? error : failure(error)}{login && <> <button type="button" className="linkish" onClick={() => toLogin(true)}>{tr("Erneut anmelden")}</button></>}</span></p>;
}

/** Nativer Dialog mit Abbrechen per Escape; ohne showModal (ältere Umgebungen) wird er einfach geöffnet. */
function Modal({ label, onClose, busy, children }: { label: string; onClose: () => void; busy: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
    return () => { if (typeof d.close === "function") d.close(); };
  }, []);
  return <dialog ref={ref} className="kn-modal kb-modal" aria-label={label} onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>{children}</dialog>;
}

function useSubmit(action: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true); setError(undefined);
    try { await action(); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return { busy, error, submit };
}

export function NewTaskDialog({ assignees, tasks, onClose, onCreate }: {
  assignees: string[]; tasks: Card[]; onClose: () => void;
  onCreate: (t: { title: string; body: string; assignee: string; priority: number; status: "todo" | "ready" | "triage"; parents: string[] }) => Promise<void>;
}) {
  const [f, setF] = useState({ title: "", body: "", assignee: "", priority: 0, status: "ready" as "todo" | "ready" | "triage", parents: [] as string[] });
  const { busy, error, submit } = useSubmit(async () => { await onCreate({ ...f, title: f.title.trim() }); });
  return (
    <Modal label={tr("Neue Aufgabe")} onClose={onClose} busy={busy}>
      <form className="card" onSubmit={(e) => void submit(e)}>
        <h2>{tr("Neue Aufgabe")}</h2>
        <label className="col kb-lab">{tr("Titel *")}<input className="field field-line" autoFocus required maxLength={300} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
        <label className="col kb-lab">{tr("Text (Markdown)")}<textarea className="field" rows={5} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
        <div className="row kb-grid">
          <label className="col kb-lab">{tr("Zugewiesen an")}<select className="field field-line" value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })}>
            <option value="">{tr("Niemand")}</option>{assignees.map((a) => <option key={a} value={a}>{a}</option>)}</select></label>
          <label className="col kb-lab">{tr("Priorität")}<input className="field field-line" type="number" min={-100} max={100} value={f.priority} onChange={(e) => setF({ ...f, priority: Number(e.target.value) || 0 })} /></label>
          <label className="col kb-lab">{tr("Status")}<select className="field field-line" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as typeof f.status })}>
            <option value="ready">{tr("ready (bereit)")}</option><option value="todo">{tr("todo (offen)")}</option><option value="triage">{tr("triage (Einordnung)")}</option></select></label>
        </div>
        <label className="col kb-lab">{tr("Eltern-Aufgaben (erst danach startet diese)")}<select className="field" multiple size={4} aria-label={tr("Eltern-Aufgaben")} value={f.parents}
          onChange={(e) => setF({ ...f, parents: Array.from(e.target.selectedOptions, (o) => o.value) })}>
          {tasks.map((t) => <option key={t.id} value={t.id}>{t.title} ({t.id})</option>)}</select></label>
        <Banner error={error} />
        <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-s" disabled={busy} onClick={onClose}>{tr("Abbrechen")}</button>
          <button type="submit" className="btn btn-s btn-p" disabled={busy || !f.title.trim()}>{busy ? tr("Lege an…") : tr("Aufgabe anlegen")}</button>
        </div>
      </form>
    </Modal>
  );
}

export function BoardDialog({ board, onClose, onSave }: {
  board?: BoardMeta; onClose: () => void; onSave: (b: { slug: string; name: string; description: string; color: string }) => Promise<void>;
}) {
  const [f, setF] = useState({ slug: board?.slug ?? "", name: board?.name ?? "", description: board?.description ?? "", color: board?.color ?? "" });
  const slugOk = !!board || /^[a-z0-9][a-z0-9_-]{0,63}$/.test(f.slug);
  const { busy, error, submit } = useSubmit(async () => { await onSave({ ...f, name: f.name.trim() }); });
  return (
    <Modal label={board ? tr("Board bearbeiten") : tr("Neues Board")} onClose={onClose} busy={busy}>
      <form className="card" onSubmit={(e) => void submit(e)}>
        <h2>{board ? tr("Board bearbeiten") : tr("Neues Board")}</h2>
        <label className="col kb-lab">{tr("Name *")}<input className="field field-line" autoFocus required maxLength={80} value={f.name}
          onChange={(e) => setF({ ...f, name: e.target.value, slug: board || f.slug !== slugOf(f.name) ? f.slug : slugOf(e.target.value) })} /></label>
        <label className="col kb-lab">{tr("Kennung (slug){board}", { board: board ? tr(" (nicht änderbar)") : "" })}<input className="field field-line mono" required disabled={!!board} value={f.slug}
          onChange={(e) => setF({ ...f, slug: e.target.value })} aria-invalid={!slugOk} />
          {!slugOk && <span className="hint">{tr("Nur Kleinbuchstaben, Ziffern, Bindestrich und Unterstrich, höchstens 64 Zeichen.")}</span>}</label>
        <label className="col kb-lab">{tr("Beschreibung")}<textarea className="field" rows={3} maxLength={300} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
        <label className="col kb-lab">{tr("Farbe")}<span className="row" style={{ gap: 8 }}>
          <input type="color" aria-label={tr("Farbe wählen")} value={f.color || "#888888"} onChange={(e) => setF({ ...f, color: e.target.value })} />
          <span className="mono small t3">{f.color || tr("keine")}</span>
          {f.color && <button type="button" className="btn btn-s btn-g" onClick={() => setF({ ...f, color: "" })}>{tr("Entfernen")}</button>}</span></label>
        <Banner error={error} />
        <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-s" disabled={busy} onClick={onClose}>{tr("Abbrechen")}</button>
          <button type="submit" className="btn btn-s btn-p" disabled={busy || !f.name.trim() || !slugOk || !f.slug}>{busy ? tr("Speichere…") : board ? tr("Speichern") : tr("Board anlegen")}</button>
        </div>
      </form>
    </Modal>
  );
}

const slugOf = (name: string) => name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

export function ArchiveDialog({ task, onClose, onConfirm }: { task: { id: string; title: string }; onClose: () => void; onConfirm: () => Promise<void> }) {
  const { busy, error, submit } = useSubmit(onConfirm);
  return (
    <Modal label={tr("Aufgabe archivieren")} onClose={onClose} busy={busy}>
      <div className="card">
        <h2>{tr("Aufgabe archivieren?")}</h2>
        <p style={{ margin: 0 }}><b>{task.title}</b> <span className="mono small t3">({task.id})</span></p>
        <p className="hint" style={{ margin: 0 }}>{tr("Die Aufgabe verschwindet vom Board. Mit „Archivierte zeigen“ ist sie weiter sichtbar. Gelöscht wird nichts.")}</p>
        <Banner error={error} />
        <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-s" disabled={busy} onClick={onClose}>{tr("Abbrechen")}</button>
          <button type="button" className="btn btn-s btn-danger" disabled={busy} onClick={() => void submit()}>{busy ? tr("Archiviere…") : tr("Archivieren")}</button>
        </div>
      </div>
    </Modal>
  );
}
