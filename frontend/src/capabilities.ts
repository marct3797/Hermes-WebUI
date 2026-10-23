import type { SkillInfo, ToolsetInfo } from "./types";

type Rec = Record<string, unknown>;
const obj = (v: unknown): Rec | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Eintragsliste aus einer Antwort: Hermes nennt sie `data`, andere Formen `skills`/`toolsets`/`items` oder liefern gleich eine Liste. */
function rowsOf(payload: unknown, ...keys: string[]): Rec[] {
  const list = Array.isArray(payload) ? payload : ["data", ...keys, "items"].map((k) => obj(payload)?.[k]).find(Array.isArray);
  return Array.isArray(list) ? list.flatMap((r) => { const o = obj(r); return o ? [o] : []; }) : [];
}

export function parseSkills(payload: unknown): SkillInfo[] {
  return rowsOf(payload, "skills").flatMap((r): SkillInfo[] => {
    const name = str(r.name) ?? str(r.id);
    return name ? [{ name, description: str(r.description) ?? str(r.summary), category: str(r.category) }] : [];
  }).sort((a, b) => Number(!a.category) - Number(!b.category) || (a.category ?? "").localeCompare(b.category ?? "") || a.name.localeCompare(b.name)); // ohne Kategorie ans Ende
}

export function parseToolsets(payload: unknown): ToolsetInfo[] {
  return rowsOf(payload, "toolsets").flatMap((r): ToolsetInfo[] => {
    const name = str(r.name) ?? str(r.id) ?? str(r.key);
    if (!name) return [];
    const tools = Array.isArray(r.tools) ? r.tools.flatMap((t) => (typeof t === "string" ? [t] : str(obj(t)?.name) ? [str(obj(t)?.name)!] : [])) : undefined;
    return [{
      name, label: str(r.label) ?? str(r.title), description: str(r.description),
      enabled: typeof r.enabled === "boolean" ? r.enabled : undefined,
      configured: typeof r.configured === "boolean" ? r.configured : undefined,
      tools,
    }];
  });
}
