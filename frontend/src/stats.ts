import { toMs } from "./format";
import { t as tr } from "./i18n";

/** Auswertung aus den Sessions, die Hermes ohnehin liefert (`/api/sessions`): Tokens, Tool-Aufrufe, Kosten, Modelle. */
export type SessionStat = {
  agent: string;
  startedAt: number;
  durationMs?: number;
  source: string;
  model: string;
  messages: number;
  toolCalls: number;
  apiCalls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number;
};

type Row = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** Zeilen einer Sessions-Antwort (`data`, `sessions` oder Liste) in Kennzahlen; Zeilen ohne Zeitstempel fallen weg. */
export function sessionStats(agent: string, payload: unknown): SessionStat[] {
  const p = payload as { data?: unknown[]; sessions?: unknown[]; items?: unknown[] } | null;
  const list = Array.isArray(payload) ? payload : p?.data ?? p?.sessions ?? p?.items ?? [];
  if (!Array.isArray(list)) return [];
  const out: SessionStat[] = [];
  for (const raw of list as Row[]) {
    if (!raw || typeof raw !== "object") continue;
    const started = toMs(raw.started_at as number | string | undefined) ?? toMs(raw.last_active as number | string | undefined) ?? toMs(raw.updated_at as number | string | undefined);
    if (started === undefined) continue;
    const ended = toMs(raw.ended_at as number | string | undefined);
    out.push({
      agent, startedAt: started, durationMs: ended !== undefined && ended >= started ? ended - started : undefined,
      source: typeof raw.source === "string" && raw.source ? raw.source : tr("unbekannt"),
      model: typeof raw.model === "string" && raw.model ? raw.model : tr("unbekannt"),
      messages: num(raw.message_count), toolCalls: num(raw.tool_call_count), apiCalls: num(raw.api_call_count),
      input: num(raw.input_tokens), output: num(raw.output_tokens), cacheRead: num(raw.cache_read_tokens),
      cacheWrite: num(raw.cache_write_tokens), reasoning: num(raw.reasoning_tokens),
      cost: num(raw.actual_cost_usd) || num(raw.estimated_cost_usd),
    });
  }
  return out;
}

export type Totals = { sessions: number; messages: number; toolCalls: number; input: number; output: number; cacheRead: number; reasoning: number; cost: number };
export type DayBucket = { day: number; sessions: number; tokens: number };
export type Usage = {
  totals: Totals;
  /** Anteil der Eingabe, der aus dem Cache kam (0–1); `undefined`, wenn nichts gelesen wurde. */
  cacheShare?: number;
  days: DayBucket[];
  byAgent: Array<Totals & { agent: string }>;
  byModel: Array<{ model: string; sessions: number; tokens: number }>;
  bySource: Array<{ source: string; sessions: number }>;
};

const empty = (): Totals => ({ sessions: 0, messages: 0, toolCalls: 0, input: 0, output: 0, cacheRead: 0, reasoning: 0, cost: 0 });
const add = (t: Totals, s: SessionStat) => {
  t.sessions += 1; t.messages += s.messages; t.toolCalls += s.toolCalls; t.input += s.input; t.output += s.output;
  t.cacheRead += s.cacheRead; t.reasoning += s.reasoning; t.cost += s.cost;
};
export const tokensOf = (t: Pick<Totals, "input" | "output">) => t.input + t.output;

/** Beginn des Kalendertags (lokale Zeit). */
const dayStart = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);

/** Zeitraum: die letzten `days` Kalendertage einschließlich heute. Jeder Tag erscheint, auch ohne Sessions. */
export function aggregate(stats: SessionStat[], days: number, now = Date.now()): Usage {
  const first = dayStart(now) - (days - 1) * 86_400_000;
  const inRange = stats.filter((s) => s.startedAt >= first && s.startedAt <= now + 3_600_000);
  const totals = empty();
  const buckets = new Map<number, DayBucket>();
  for (let i = 0; i < days; i++) {
    // Kalendertage statt fester 24-Stunden-Schritte: Zeitumstellung verschiebt sonst die Tage.
    const d = new Date(first); d.setDate(d.getDate() + i);
    buckets.set(d.getTime(), { day: d.getTime(), sessions: 0, tokens: 0 });
  }
  const agents = new Map<string, Totals>();
  const models = new Map<string, { sessions: number; tokens: number }>();
  const sources = new Map<string, number>();
  for (const s of inRange) {
    add(totals, s);
    const b = buckets.get(dayStart(s.startedAt));
    if (b) { b.sessions += 1; b.tokens += s.input + s.output; }
    const a = agents.get(s.agent) ?? empty(); add(a, s); agents.set(s.agent, a);
    const m = models.get(s.model) ?? { sessions: 0, tokens: 0 }; m.sessions += 1; m.tokens += s.input + s.output; models.set(s.model, m);
    sources.set(s.source, (sources.get(s.source) ?? 0) + 1);
  }
  const prompt = totals.input + totals.cacheRead;
  return {
    totals,
    cacheShare: prompt > 0 && totals.cacheRead > 0 ? totals.cacheRead / prompt : undefined,
    days: [...buckets.values()],
    byAgent: [...agents].map(([agent, t]) => ({ agent, ...t })).sort((x, y) => tokensOf(y) - tokensOf(x) || y.sessions - x.sessions),
    byModel: [...models].map(([model, v]) => ({ model, ...v })).sort((x, y) => y.tokens - x.tokens || y.sessions - x.sessions),
    bySource: [...sources].map(([source, sessions]) => ({ source, sessions })).sort((x, y) => y.sessions - x.sessions),
  };
}

/** 1.234 · 12,3 k · 4,56 M */
export function fmtTokens(n: number): string {
  if (n < 10_000) return n.toLocaleString("de-DE");
  if (n < 1_000_000) return `${(n / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 })} k`;
  return `${(n / 1_000_000).toLocaleString("de-DE", { maximumFractionDigits: 2 })} M`;
}

export const fmtUsd = (n: number) => `${n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
