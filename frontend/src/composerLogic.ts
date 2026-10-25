import { t } from "./i18n";
/** Reine Logik der Chat-Eingabe: Aufwand, Auslöser für Menüs, Anhänge und die Darstellung angehängter Kontexte. */

export type Effort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
/** `undefined` heißt: Standard des Agents, es wird nichts gesendet. */
export type Reasoning = { thinking: boolean; effort?: Effort };

export const EFFORTS: { value: Effort; label: string }[] = [
  { value: "minimal", get label() { return t("Minimal"); } }, { value: "low", get label() { return t("Niedrig"); } }, { value: "medium", get label() { return t("Mittel"); } },
  { value: "high", get label() { return t("Hoch"); } }, { value: "xhigh", get label() { return t("Extra hoch"); } }, { value: "max", get label() { return t("Max"); } }, { value: "ultra", get label() { return t("Ultra"); } },
];

export function reasoningLabel(r?: Reasoning): string {
  if (!r) return t("Standard");
  if (!r.thinking) return t("Aus");
  return r.effort ? EFFORTS.find((e) => e.value === r.effort)!.label : "An";
}

/** Das Feld `model_options` des Run-Requests (Hermes: model_options.reasoning). */
export function modelOptions(r?: Reasoning): { reasoning: { enabled: boolean; effort?: Effort } } | undefined {
  if (!r) return undefined;
  return { reasoning: r.thinking ? { enabled: true, ...(r.effort ? { effort: r.effort } : {}) } : { enabled: false } };
}

const KEY = (agentKey: string) => `hermes-webui-reasoning:${agentKey}`;

export function loadReasoning(agentKey: string): Reasoning | undefined {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY(agentKey)) ?? "null");
    if (!v || typeof v !== "object") return undefined;
    const { thinking, effort } = v as Record<string, unknown>;
    if (typeof thinking !== "boolean") return undefined;
    if (effort === undefined) return { thinking };
    return EFFORTS.some((e) => e.value === effort) ? { thinking, effort: effort as Effort } : undefined;
  } catch { return undefined; }
}

export function saveReasoning(agentKey: string, r?: Reasoning) {
  try { if (r) localStorage.setItem(KEY(agentKey), JSON.stringify(r)); else localStorage.removeItem(KEY(agentKey)); } catch { /* privater Modus */ }
}

const ALIASES: Record<string, Effort> = {
  minimal: "minimal", niedrig: "low", low: "low", mittel: "medium", medium: "medium", hoch: "high", high: "high",
  xhigh: "xhigh", extra: "xhigh", max: "max", ultra: "ultra",
};

/** Argument von `/reasoning`: Stufe, aus/an, standard. `undefined` bei leerem Argument, `"invalid"` bei Unbekanntem. */
export function parseReasoningArg(arg: string): { value: Reasoning | undefined } | "invalid" | undefined {
  const a = arg.trim().toLowerCase();
  if (!a) return undefined;
  if (["standard", "default", "auto"].includes(a)) return { value: undefined };
  if (["aus", "off", "none", "nein"].includes(a)) return { value: { thinking: false } };
  if (["an", "on", "ein"].includes(a)) return { value: { thinking: true } };
  return ALIASES[a] ? { value: { thinking: true, effort: ALIASES[a] } } : "invalid";
}

export type Trigger = { kind: "slash" | "at"; query: string; start: number };

/** Menü-Auslöser vor dem Cursor: `/` am Zeilenanfang oder `@` am Wortanfang. */
export function detectTrigger(text: string, caret: number): Trigger | undefined {
  const before = text.slice(0, caret);
  const slash = /(?:^|\n)\/([^\s/]*)$/.exec(before);
  if (slash) return { kind: "slash", query: slash[1], start: before.length - slash[1].length - 1 };
  const at = /(?:^|[\s(])@(\S*)$/.exec(before);
  if (at) return { kind: "at", query: at[1], start: before.length - at[1].length - 1 };
  return undefined;
}

/** `/name Argumente` in der ersten Zeile; `/usr/bin` und Ähnliches ist kein Befehl. */
export function parseSlashInput(text: string): { name: string; args: string } | undefined {
  const m = /^\/([A-Za-z0-9_.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1], args: (m[2] ?? "").trim() } : undefined;
}

const NEEDS_QUOTING = /[\s()[\]{}<>"'`]/;
/** Wie `format_reference_value` in Hermes: Werte mit Leerzeichen und Klammern werden gequotet. */
export function formatRefValue(value: string): string {
  if (!NEEDS_QUOTING.test(value)) return value;
  for (const q of ["`", '"', "'"]) if (!value.includes(q)) return `${q}${value}${q}`;
  return value;
}

export const hasContextRefs = (text: string) => /(?<![\w/])@(?:(?:diff|staged)\b|(?:file|folder|git):\S)/.test(text);

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);
export const MARKER = "\n\n--- Attached Context ---\n\n";
const WARNINGS = "\n\n--- Context Warnings ---\n";

function fenceFor(content: string): string {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(longest + 1);
}

const LANG: Record<string, string> = { py: "python", js: "javascript", ts: "typescript", tsx: "tsx", jsx: "jsx", json: "json", md: "markdown", sh: "bash", yml: "yaml", yaml: "yaml", toml: "toml" };

/** Lokale Textdatei als Block im Format der Hermes-Kontextblöcke. */
export function attachmentBlock(name: string, content: string): string {
  const fence = fenceFor(content);
  const lang = LANG[name.split(".").pop()?.toLowerCase() ?? ""] ?? "";
  return `📎 ${name} (${estimateTokens(content)} tokens)\n${fence}${lang}\n${content}\n${fence}`;
}

export function joinContext(text: string, blocks: string[]): string {
  if (!blocks.length) return text;
  return text.includes(MARKER) ? `${text}\n\n${blocks.join("\n\n")}` : `${text}${MARKER}${blocks.join("\n\n")}`;
}

export type ContextChip = { kind: "file" | "folder" | "diff" | "url" | "attachment" | "skill" | "warning" | "other"; title: string; tokens?: number; code: string };

const ICON_KIND: Record<string, ContextChip["kind"]> = { "📄": "file", "📁": "folder", "🧾": "diff", "🌐": "url", "📎": "attachment", "📌": "other" };
const HEADER = /^(📄|📁|🧾|🌐|📎|📌) (.+?) \((\d+) tokens\)$/;
const SKILL_HEAD = /^\[IMPORTANT: The user has invoked the "([^"]*)" skill[^\]]*\]/;
const SKILL_INSTRUCTION = "The user has provided the following instruction alongside the skill invocation: ";

function parseBlocks(rest: string): ContextChip[] {
  const chips: ContextChip[] = [];
  let cur: { chip: ContextChip; lines: string[] } | undefined;
  let fence = "";
  const done: { chip: ContextChip; lines: string[] }[] = [];
  for (const line of rest.split("\n")) {
    if (!fence) {
      const h = HEADER.exec(line);
      if (h) { cur = { chip: { kind: ICON_KIND[h[1]], title: h[2], tokens: Number(h[3]), code: "" }, lines: [] }; done.push(cur); continue; }
    }
    if (!cur) continue;
    cur.lines.push(line);
    const f = /^(`{3,})/.exec(line);
    if (f) { if (!fence) fence = f[1]; else if (line.trim() === fence || (f[1].length >= fence.length && line.trim() === f[1])) fence = ""; }
  }
  for (const d of done) chips.push({ ...d.chip, code: d.lines.join("\n").trim() });
  return chips;
}

/** Zerlegt eine gesendete Nachricht in Originaltext und angehängte Kontexte (Dateien, Diffs, Skill-Anweisung). */
export function splitContext(text: string): { body: string; chips: ContextChip[] } {
  const skill = SKILL_HEAD.exec(text);
  if (skill) {
    const at = text.lastIndexOf(SKILL_INSTRUCTION);
    const instruction = at >= 0 ? text.slice(at + SKILL_INSTRUCTION.length) : "";
    const inner = splitContext(instruction);
    const content = (at >= 0 ? text.slice(0, at) : text).slice(skill[0].length).trim();
    return {
      body: `/${skill[1]}${inner.body ? ` ${inner.body}` : ""}`,
      chips: [{ kind: "skill", title: `Skill ${skill[1]}`, tokens: estimateTokens(content), code: content }, ...inner.chips],
    };
  }
  const idx = text.indexOf(MARKER);
  let head = idx >= 0 ? text.slice(0, idx) : text;
  const chips: ContextChip[] = [];
  const w = head.indexOf(WARNINGS);
  if (w >= 0) {
    for (const line of head.slice(w + WARNINGS.length).split("\n")) if (line.startsWith("- ")) chips.push({ kind: "warning", title: line.slice(2), code: "" });
    head = head.slice(0, w);
  } else if (idx >= 0 && !/^📄|^📁|^🧾|^🌐|^📎|^📌/m.test(text.slice(idx))) {
    return { body: text, chips: [] };
  }
  const blocks = idx >= 0 ? parseBlocks(text.slice(idx + MARKER.length)) : [];
  return { body: head, chips: [...chips, ...blocks] };
}
