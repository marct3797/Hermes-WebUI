import type { Item } from "./types";
import { t as tr } from "./i18n";

type Msg = Record<string, unknown>;
type Tool = Extract<Item, { kind: "tool" }>;

let counter = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${counter++}`;

/** Ausgaben können riesig sein (Dateiinhalte, Logs): die Anzeige braucht nicht mehr. */
const MAX_OUTPUT = 20_000;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const obj = (v: unknown): Msg | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Msg) : undefined);

/** Text einer Nachricht: String oder Liste von Teilen mit `text`. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (obj(p) && typeof obj(p)!.text === "string" ? (obj(p)!.text as string) : "")).join("");
  return "";
}

/** Zeitstempel in Millisekunden; Hermes liefert Sekunden mit Nachkommastellen. */
function millis(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
  return v < 1e11 ? Math.round(v * 1000) : Math.round(v);
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

const SUMMARY_KEYS = ["command", "cmd", "path", "file_path", "filepath", "query", "url", "pattern", "text", "code", "name"];
const firstLine = (s: string) => (s.split("\n").find((l) => l.trim()) ?? s).trim().slice(0, 160);

/** Eine Zeile für die Tool-Karte: der aussagekräftigste Parameter, sonst der Anfang der Argumente. */
export function argSummary(args: unknown): string | undefined {
  if (typeof args === "string") return str(args) ? firstLine(args) : undefined;
  const o = obj(args);
  if (!o) return undefined;
  for (const k of SUMMARY_KEYS) {
    const v = str(o[k]);
    if (v) return firstLine(v);
  }
  const text = JSON.stringify(o);
  return text === "{}" ? undefined : text.slice(0, 160);
}

const argsText = (args: unknown): string | undefined => {
  if (args === undefined || args === null || args === "") return undefined;
  const text = typeof args === "string" ? args : JSON.stringify(args);
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}…` : text;
};

/**
 * Ausgabe eines Tools. Hermes' Tools antworten oft mit JSON (`output`, `exit_code`, `error`): dann steht der Text
 * da, ein Exit-Code ungleich 0 oder ein Fehlerfeld färbt die Karte. Alles andere bleibt, wie es ist.
 */
export function toolResult(content: unknown): { output: string; failed: boolean } {
  let text = textOf(content);
  let failed = false;
  try {
    const v: unknown = JSON.parse(text);
    const o = obj(v);
    if (o) {
      const body = str(o.output) ?? str(o.stdout) ?? str(o.content) ?? str(o.result);
      const err = str(o.error) ?? str(o.stderr);
      const code = typeof o.exit_code === "number" ? o.exit_code : typeof o.returncode === "number" ? o.returncode : 0;
      if (body !== undefined || err !== undefined || "exit_code" in o) {
        text = [body, err && err !== body ? err : undefined, code !== 0 ? `[Exit-Code ${code}]` : undefined].filter(Boolean).join("\n");
        failed = code !== 0 || (!!str(o.error) && body === undefined);
      }
    }
  } catch { /* kein JSON: Text unverändert */ }
  if (text.length > MAX_OUTPUT) text = tr("{MAX_OUTPUT}\n… (gekürzt)", { MAX_OUTPUT: text.slice(0, MAX_OUTPUT) });
  return { output: text, failed };
}

type Call = { id?: string; name: string; args: unknown };

function toolCalls(raw: unknown): Call[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((tc): Call[] => {
    const o = obj(tc);
    if (!o) return [];
    const fn = obj(o.function) ?? o;
    const name = str(fn.name) ?? str(o.name) ?? str(o.tool);
    if (!name) return [];
    return [{ id: str(o.id) ?? str(o.tool_call_id) ?? str(o.call_id), name, args: parseArgs(fn.arguments ?? fn.args ?? o.arguments ?? o.args) }];
  });
}

/**
 * Verlauf aus /api/sessions/{id}/messages: Nutzer- und Assistententext, dazu Tool-Aufrufe mit Argumenten und Ausgabe
 * (Assistenten-Nachrichten tragen `tool_calls`, die Ergebnisse stehen in Nachrichten mit Rolle `tool`) und der Denkprozess.
 */
export function historyItems(payload: unknown): Item[] {
  // Mock und ältere Formen: `messages`; Hermes' Listen heißen sonst `data` (wie bei den Sessions).
  const p = payload as { messages?: unknown[]; data?: unknown[]; items?: unknown[] } | null;
  const list = Array.isArray(payload) ? payload : p?.messages ?? p?.data ?? p?.items ?? [];
  const items: Item[] = [];
  const byCall = new Map<string, Tool>();
  const open: Tool[] = [];

  for (const entry of list) {
    const raw = obj(entry);
    if (!raw) continue;
    const role = raw.role;
    const at = millis(raw.timestamp);
    if (role === "user") {
      const text = textOf(raw.content);
      if (text.trim()) items.push({ kind: "message", id: uid("h"), role: "user", text, reasoning: "", streaming: false, images: [], at });
    } else if (role === "assistant") {
      const text = textOf(raw.content);
      const reasoning = str(raw.reasoning) ?? str(raw.reasoning_content) ?? "";
      if (text.trim() || reasoning) items.push({ kind: "message", id: uid("h"), role: "assistant", text, reasoning, streaming: false, images: [], at });
      for (const c of toolCalls(raw.tool_calls)) {
        const tool: Tool = { kind: "tool", id: c.id ?? uid("h"), name: c.name, preview: argSummary(c.args), args: argsText(c.args), status: "ok", at, enriched: true };
        items.push(tool);
        open.push(tool);
        if (c.id) byCall.set(c.id, tool);
      }
    } else if (role === "tool") {
      const { output, failed } = toolResult(raw.content);
      const id = str(raw.tool_call_id);
      const name = str(raw.tool_name) ?? str(raw.name);
      // Zuordnung: erst über die Aufruf-Kennung, sonst der älteste offene Aufruf gleichen Namens.
      const target = (id ? byCall.get(id) : undefined)
        ?? open.find((t) => t.output === undefined && (!name || t.name === name));
      if (target) {
        target.output = output;
        if (failed) target.status = "error";
      } else {
        items.push({ kind: "tool", id: id ?? uid("h"), name: name ?? "tool", output, status: failed ? "error" : "ok", at, enriched: true });
      }
    }
  }
  return items;
}

/**
 * Hermes' Ereignisstrom meldet Tool-Aufrufe ohne Ausgabe und mit gekürzter Vorschau. Der vollständige Stand steht im Verlauf:
 * Er ergänzt die Karten des laufenden Chats um Argumente und Ausgabe. Zugeordnet wird von hinten nach Namen und Reihenfolge,
 * weil Hermes den Ereignissen keine Aufruf-Kennung mitgibt. Liefert dasselbe Array zurück, wenn sich nichts ändert.
 */
export function enrichTools(items: Item[], history: Item[]): Item[] {
  const hist = history.filter((i): i is Tool => i.kind === "tool");
  if (hist.length === 0) return items;
  const next = [...items];
  let j = hist.length - 1;
  let changed = false;
  for (let i = next.length - 1; i >= 0 && j >= 0; i--) {
    const it = next[i];
    if (it.kind !== "tool" || it.enriched) continue;
    while (j >= 0 && hist[j].name !== it.name) j--;
    if (j < 0) break;
    const h = hist[j--];
    if (h.output === undefined && h.args === undefined) continue; // der Aufruf steht schon im Verlauf, das Ergebnis noch nicht
    next[i] = {
      ...it,
      args: h.args ?? it.args,
      output: h.output ?? it.output,
      preview: it.preview ?? h.preview,
      status: h.status === "error" && it.status === "ok" ? "error" : it.status,
      // Ein Aufruf ohne Ergebnis bleibt offen, damit der nächste Abgleich ihn noch einmal versucht.
      enriched: h.output !== undefined,
    };
    changed = true;
  }
  return changed ? next : items;
}
