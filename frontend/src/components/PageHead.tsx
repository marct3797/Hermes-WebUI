import type { ReactNode } from "react";

/** Titelzeile der Übersichtsseiten: Titel, Kennzahlen in Mono und rechts die Aktionen. */
export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="ph">
      <h1>{title}</h1>
      {sub && <span className="ph-sub">{sub}</span>}
      {children && <div className="row grow" style={{ justifyContent: "flex-end", gap: 8 }}>{children}</div>}
    </header>
  );
}
