/** Symbole als CSS-Masken (styles/icons.css): erben die Textfarbe, tragen keine eigene Bedeutung. */
export type IconSize = 12 | 14 | 16 | 18 | 20;

export function Icon({ name, size = 16, className }: { name: string; size?: IconSize; className?: string }) {
  const cls = ["ic", `i-${name}`, size !== 16 ? `ic-${size}` : "", className ?? ""].filter(Boolean).join(" ");
  return <span className={cls} aria-hidden />;
}
