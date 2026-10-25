import type { AgentActivity } from "../attention";
import { t } from "../i18n";

/** Zustände tragen Form und Farbe, nie nur Farbe: bereit = heller Punkt, offline = hohler Ring, Zugangsfehler = Raute. */
export const STATUS_LABEL: Record<string, string> = {
  online: "online",
  sleeping: "schläft",
  get unreachable() { return t("nicht erreichbar"); },
  auth_error: "Zugang abgelehnt",
  gone: "Profil entfernt",
  get unsupported() { return t("nicht unterstützt"); },
};

const DOT_CLASS: Record<string, string> = {
  online: "dot-on",
  sleeping: "",
  unreachable: "dot-off",
  auth_error: "dot-err",
  gone: "dot-off",
  unsupported: "dot-off",
};

export const dotClass = (status: string) => DOT_CLASS[status] ?? "dot-off";

export function StatusDot({ status }: { status: string }) {
  const text = STATUS_LABEL[status] ?? status;
  return <span className={`dot ${dotClass(status)}`.trim()} role="img" aria-label={text} title={text} />;
}

/** Punkt eines Agents: was die Person braucht, geht vor „läuft“, dann Fehler, sonst der Zustand der Runtime. */
export function activityDot(act: AgentActivity | undefined, status: string): string {
  if (act?.waiting) return "dot-wait";
  if (act?.running) return "dot-run";
  if (act?.failed) return "dot-err";
  return dotClass(status);
}

export function AgentDot({ act, status }: { act?: AgentActivity; status: string }) {
  const text = act?.waiting ? t("wartet auf dich") : act?.running ? "läuft" : act?.failed ? t("Fehler") : STATUS_LABEL[status] ?? status;
  return <span className={`dot ${activityDot(act, status)}`.trim()} role="img" aria-label={text} title={text} />;
}
