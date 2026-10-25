/** Farben der Konstellation: Aktualität als Verlauf, Kontext/Entität/Gruppe als Palette, Verknüpfungstypen fest. */
import type { MemNode } from "./types";
import { t as tr } from "./i18n";

export const LINK_COLORS: Record<string, string> = { semantic: "#4f8cff", temporal: "#2dd4bf", entity: "#ff9f43", causal: "#a855f7" };
export const LINK_NAMES: Record<string, string> = { semantic: "Semantic", temporal: "Temporal", entity: "Entity", causal: "Causal" };
export const OTHER_LINK = "#9ca3af";
export const linkColor = (t: string | null | undefined) => LINK_COLORS[t ?? ""] ?? OTHER_LINK;

export type ColorMode = "recency" | "context" | "entity" | "group";
export const COLOR_MODES: Array<{ id: ColorMode; label: string }> = [
  { id: "recency", get label() { return tr("Aktualität"); } }, { id: "context", get label() { return tr("Kontext"); } }, { id: "entity", get label() { return tr("Entität"); } }, { id: "group", get label() { return tr("Gruppen"); } },
];

const PALETTE = ["#f87171", "#60a5fa", "#34d399", "#fbbf24", "#a78bfa", "#2dd4bf", "#fb923c", "#f472b6"];
const NONE = "#6b7280";
const STOPS: Array<[number, [number, number, number]]> = [[0, [79, 140, 255]], [0.5, [162, 89, 255]], [0.85, [255, 138, 61]], [1, [255, 77, 77]]];

/** 0 = ältestes (blau), 1 = neuestes (rot). */
export function recencyColor(t: number): string {
  const v = Math.min(1, Math.max(0, t));
  const i = Math.max(1, STOPS.findIndex(([at]) => at >= v));
  const [a, ca] = STOPS[i - 1], [b, cb] = STOPS[i];
  const f = b === a ? 0 : (v - a) / (b - a);
  return `rgb(${ca.map((c, j) => Math.round(c + (cb[j] - c) * f)).join(",")})`;
}

export type Coloring = { colors: string[]; legend: Array<{ label: string; color: string; count: number }>; scale?: { min: number; max: number } };
export type Grouping = { of: number[]; titles: string[] };

function byCategory(values: Array<string | null>, label: (v: string) => string): Coloring {
  const count = new Map<string, number>();
  for (const v of values) if (v) count.set(v, (count.get(v) ?? 0) + 1);
  const top = [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, PALETTE.length);
  const color = new Map(top.map(([v], i) => [v, PALETTE[i]]));
  const rest = values.filter((v) => !v || !color.has(v)).length;
  return {
    colors: values.map((v) => (v && color.get(v)) || NONE),
    legend: [...top.map(([v, c]) => ({ label: label(v), color: color.get(v)!, count: c })), ...(rest ? [{ label: tr("Andere"), color: NONE, count: rest }] : [])],
  };
}

export function colorNodes(mode: ColorMode, nodes: MemNode[], grouping?: Grouping): Coloring {
  if (mode === "recency") {
    const ts = nodes.map((n) => (n.date ? Date.parse(n.date) : NaN));
    const known = ts.filter(Number.isFinite);
    if (!known.length) return { colors: nodes.map(() => NONE), legend: [] };
    const min = Math.min(...known), max = Math.max(...known);
    return { colors: ts.map((t) => (Number.isFinite(t) ? recencyColor(max === min ? 1 : (t - min) / (max - min)) : NONE)), legend: [], scale: { min, max } };
  }
  if (mode === "context") return byCategory(nodes.map((n) => n.context), (v) => v);
  if (mode === "entity") {
    const freq = new Map<string, number>();
    for (const n of nodes) for (const e of n.entities) freq.set(e, (freq.get(e) ?? 0) + 1);
    // Eine Entität je Knoten: die im ganzen Ausschnitt häufigste seiner Entitäten.
    return byCategory(nodes.map((n) => [...n.entities].sort((a, b) => (freq.get(b)! - freq.get(a)!) || a.localeCompare(b))[0] ?? null), (v) => v);
  }
  const of = grouping?.of ?? [];
  return byCategory(nodes.map((_, i) => (of[i] >= 0 ? String(of[i]) : null)), (v) => grouping?.titles[Number(v)] ?? `Gruppe ${v}`);
}
