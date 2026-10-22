/** Zustände ohne Farbton: Form und Helligkeit tragen die Bedeutung, Crimson bleibt dem Handlungsbedarf vorbehalten. */
export const STATUS_LABEL: Record<string, string> = {
  online: "online",
  sleeping: "schläft",
  unreachable: "nicht erreichbar",
  auth_error: "Zugang abgelehnt",
  gone: "Profil entfernt",
  unsupported: "nicht unterstützt",
};

export function StatusDot({ status }: { status: string }) {
  const text = STATUS_LABEL[status] ?? status;
  return <span className={`status s-${status}`} role="img" aria-label={text} title={text} />;
}

/** Zwei Buchstaben plus eines von sechs Mustern (aus dem Namen abgeleitet): unterscheidbar ohne weitere Farben. */
export function Monogram({ name }: { name: string }) {
  let h = 5381;
  for (const ch of name) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
  return <span className={`monogram pat-${h % 6}`} aria-hidden>{name.slice(0, 2).toUpperCase()}</span>;
}
