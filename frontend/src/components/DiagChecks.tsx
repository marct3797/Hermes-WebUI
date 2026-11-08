import type { DiagCheck } from "../types";
import { Icon } from "./Icon";
import { t } from "../i18n";

const MARK: Record<DiagCheck["status"], { icon: string; label: string; cls: string }> = {
  ok: { icon: "check", get label() { return t("in Ordnung"); }, cls: "diag-ok" },
  warn: { icon: "alert", get label() { return t("Abweichung"); }, cls: "diag-warn" },
  fail: { icon: "x", get label() { return t("Fehler"); }, cls: "diag-fail" },
  slow: { icon: "alert", label: "langsam", cls: "diag-warn" },
};

/** Ergebnisliste einer Diagnose: Agents (System) und Gedächtnis-Anbieter teilen sich die Darstellung. */
export function DiagChecks({ checks }: { checks: DiagCheck[] }) {
  return (
    <ul className="diag-checks">
      {checks.map((c) => (
        <li key={c.id} className={MARK[c.status].cls}>
          <span className="diag-mark" role="img" aria-label={MARK[c.status].label}><Icon name={MARK[c.status].icon} size={14} /></span>
          <span className="diag-label">{c.label}</span>
          <span className="muted small diag-detail">{c.detail}</span>
          {c.ms !== null && <span className="mono t3 small">{t("{ms} ms", { ms: c.ms })}</span>}
        </li>
      ))}
    </ul>
  );
}
