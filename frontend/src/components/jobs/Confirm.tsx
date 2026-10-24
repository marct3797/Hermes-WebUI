import { useEffect, useRef, type ReactNode } from "react";

/** Bestätigungsdialog (nativer <dialog>, Escape schließt). */
export function Confirm({ title, children, label, busy, onConfirm, onClose }: { title: string; children: ReactNode; label: string; busy?: boolean; onConfirm: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    d.showModal();
    return () => d.close();
  }, []);
  return (
    <dialog ref={ref} className="kn-modal" aria-label={title} onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>
      <div className="card">
        <h2>{title}</h2>
        {children}
        <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-s" disabled={busy} onClick={onClose}>Abbrechen</button>
          <button type="button" className="btn btn-s btn-p" disabled={busy} onClick={onConfirm}>{busy ? "Bitte warten…" : label}</button>
        </div>
      </div>
    </dialog>
  );
}
