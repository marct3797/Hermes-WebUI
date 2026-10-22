import type { CSSProperties } from "react";
import type { SigilConfig } from "../types";

/** Symbole des Standards (neutral). Sie stehen als Masken in styles/icons.css. Eigene Packs und SVGs liefert das BFF. */
export const NEUTRAL_GLYPHS = [
  "bolt", "spark", "cpu", "terminal", "globe", "shield", "memory", "server", "folder", "layers", "wrench", "bell",
  "chat", "kanban", "file", "coin", "clock", "play", "refresh", "fork", "pin", "lock", "edit", "search",
] as const;

export type SigilSize = "xs" | "s" | "m" | "l" | "xl";
export type SigilState = "live" | "wait" | "err";

const SIZE_CLASS: Record<SigilSize, string> = { xs: " sg-xs", s: " sg-s", m: "", l: " sg-l", xl: " sg-xl" };
const SAFE_SRC = /^\/bff\/ui\/(sigils\/[a-z0-9_-]+|glyphs\/[a-z0-9_-]+\/[a-z0-9_-]+)\.svg$/;

export function hashHue(name: string): number {
  let h = 5381;
  for (const ch of name) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

/** Helligkeit und Sättigung sind fest, nur der Farbton ist frei: so bleibt der Kontrast gesichert. */
export function sigilColor(hue: SigilConfig["hue"], name: string): string {
  if (hue === null) return "oklch(.92 0 0)";
  const h = typeof hue === "number" ? hue : hashHue(name);
  return `oklch(.82 .12 ${Math.round(h)})`;
}

export const initialsOf = (name: string) => name.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toUpperCase() || "?";

type Props = { name: string; config?: SigilConfig; size?: SigilSize; state?: SigilState };

export function Sigil({ name, config, size = "m", state }: Props) {
  // `null` heißt neutral (grau), nur ein fehlender Wert heißt automatisch.
  const color = sigilColor(config?.hue === undefined ? "auto" : config.hue, name);
  let mask: string | undefined;
  if (config?.type === "glyph" && config.glyph) {
    const [pack, glyph] = config.glyph.split("/");
    if (pack === "neutral" && (NEUTRAL_GLYPHS as readonly string[]).includes(glyph)) mask = `var(--i-${glyph})`;
    else if (config.src && SAFE_SRC.test(config.src)) mask = `url("${config.src}")`;
  } else if (config?.type === "svg" && config.src && SAFE_SRC.test(config.src)) {
    mask = `url("${config.src}")`;
  }
  const cls = `sg${SIZE_CLASS[size]}${state ? ` ${state}` : ""}${mask ? "" : " ini"}`;
  const style = { "--id": color, ...(mask ? { "--g": mask } : {}) } as CSSProperties;
  const text = config?.type === "initials" && config.text ? config.text : initialsOf(name);
  return <span className={cls} style={style} data-i={mask ? undefined : text} aria-hidden />;
}
