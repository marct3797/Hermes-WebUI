import { useEffect, useRef, type ReactNode } from "react";

/** Nativer <dialog> (wie in der Wissensseite); Escape schließt, solange nichts läuft. */
export function Modal({ label, onClose, busy, children }: { label: string; onClose: () => void; busy?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    return () => { if (typeof dialog.close === "function") dialog.close(); };
  }, []);
  return <dialog ref={ref} className="kn-modal" aria-label={label} onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>
    <div className="card"><h2>{label}</h2>{children}</div>
  </dialog>;
}
