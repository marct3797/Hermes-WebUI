import type { ReactNode } from "react";
import { useShell } from "../shell";

/** Kopfzeile jeder Seite; auf dem Telefon öffnet der Knopf die Seitenleiste. */
export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  const { openMenu } = useShell();
  return (
    <header className="page-head">
      <button type="button" className="ghost icon menu-btn" aria-label="Menü" onClick={openMenu}>☰</button>
      <h1>{title}</h1>
      {children}
    </header>
  );
}
