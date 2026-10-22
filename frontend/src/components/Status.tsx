/** Zustände tragen Form und Farbe, nie nur Farbe: bereit = heller Punkt, offline = hohler Ring, Zugangsfehler = Raute. */
export const STATUS_LABEL: Record<string, string> = {
  online: "online",
  sleeping: "schläft",
  unreachable: "nicht erreichbar",
  auth_error: "Zugang abgelehnt",
  gone: "Profil entfernt",
  unsupported: "nicht unterstützt",
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
