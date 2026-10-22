import type { AgentRef, ProfileInput, SigilConfig, SigilInput } from "../../types";
import { NEUTRAL_GLYPHS } from "../Sigil";

/** Arbeitsstand der Profil-Seite. Er entsteht aus dem gespeicherten Eintrag, Änderungen liegen darüber. */
export type Draft = {
  label: string;
  type: SigilConfig["type"];
  /** Symbol im Format pack/name; `pack` ist der Teil davor. */
  glyph: string;
  text: string;
  hue: number | "auto" | null;
  /** Gerade gewählte, noch nicht gespeicherte SVG-Datei: Text zum Speichern, Data-URL für die Vorschau. */
  svg?: { name: string; text: string; url: string };
  /** Bereits gespeicherte SVG-Datei (URL des BFF). */
  savedSvg?: string;
};

export const DEFAULT_GLYPH = `neutral/${NEUTRAL_GLYPHS[0]}`;
export const packOf = (glyph: string) => glyph.split("/")[0];
export const nameOf = (glyph: string) => glyph.split("/")[1] ?? "";

export function baseDraft(sigil: SigilConfig | undefined, label: string | undefined): Draft {
  return {
    label: label ?? "",
    type: sigil?.type ?? "initials",
    glyph: sigil?.type === "glyph" && sigil.glyph ? sigil.glyph : DEFAULT_GLYPH,
    text: sigil?.type === "initials" ? sigil.text ?? "" : "",
    hue: sigil?.hue === undefined ? "auto" : sigil.hue,
    savedSvg: sigil?.type === "svg" ? sigil.src : undefined,
  };
}

/** Das Sigil, wie die Vorschau es zeigt. */
export function sigilOf(d: Draft): SigilConfig {
  if (d.type === "initials") return { type: "initials", text: d.text.trim() || undefined, hue: d.hue };
  if (d.type === "svg") return { type: "svg", src: d.svg?.url ?? d.savedSvg, hue: d.hue };
  const pack = packOf(d.glyph);
  return { type: "glyph", glyph: d.glyph, src: pack === "neutral" ? undefined : `/bff/ui/glyphs/${pack}/${nameOf(d.glyph)}.svg`, hue: d.hue };
}

/** Eine SVG-Datei lässt sich nur speichern, wenn eine gewählt oder schon gespeichert ist. */
export const hasSvg = (d: Draft) => !!(d.svg || d.savedSvg);

export function inputOf(agent: AgentRef, d: Draft): ProfileInput {
  const label = d.label.trim();
  const hue = typeof d.hue === "number" ? Math.round(d.hue) : d.hue;
  let sigil: SigilInput;
  if (d.type === "glyph") sigil = { type: "glyph", glyph: d.glyph, hue };
  else if (d.type === "initials") sigil = { type: "initials", ...(d.text.trim() ? { text: d.text.trim() } : {}), hue };
  else sigil = { type: "svg", hue, ...(d.svg ? { svg: d.svg.text } : {}) };
  // Ein Name, der dem Ordnernamen gleicht, braucht keinen Eintrag.
  return { label: label && label !== agent.agent ? label : null, sigil };
}

/** Der Eintrag, wie er in der ui.json stünde (ohne die äußeren Klammern), zum Prüfen und zum Kopieren. */
export function snippetOf(key: string, agent: AgentRef, d: Draft): string {
  const { label, sigil } = inputOf(agent, d);
  const slug = key.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const s: Record<string, unknown> = { type: sigil!.type };
  if (sigil!.type === "glyph") s.glyph = sigil!.glyph;
  if (sigil!.type === "initials" && sigil!.text) s.text = sigil!.text;
  if (sigil!.type === "svg") s.src = `sigils/${slug}.svg`;
  s.hue = sigil!.hue;
  const lines = JSON.stringify({ [key]: { ...(label ? { label } : {}), sigil: s } }, null, 2).split("\n");
  return lines.slice(1, -1).map((l) => l.slice(2)).join("\n");
}

const MAX_SVG = 20 * 1024;

/** Erste Prüfung im Browser; maßgeblich bleibt die Bereinigung auf dem Server. */
export function checkSvg(text: string, bytes: number): string | undefined {
  if (bytes > MAX_SVG) return "Die Datei ist größer als 20 KB.";
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement;
  if (doc.querySelector("parsererror") || root.localName !== "svg") return "Das ist kein gültiges SVG.";
  if (!root.getAttribute("viewBox")) return "Dem SVG fehlt das viewBox-Attribut.";
  return undefined;
}

export function toDataUrl(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:image/svg+xml;base64,${btoa(bin)}`;
}

export const HUES = [20, 55, 98, 145, 180, 215, 250, 295, 335] as const;
