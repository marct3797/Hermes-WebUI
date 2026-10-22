import type { ChatState, Decision, Item, SessionSummary, StreamEvent } from "./types";

export const initialState: ChatState = { items: [], runStatus: "idle" };

export type Action =
  | { type: "reset" }
  | { type: "history"; items: Item[] }
  | { type: "user-sent"; text: string; images: string[] }
  | { type: "run-accepted"; runId: string }
  | { type: "run-error"; error: string }
  | { type: "event"; event: StreamEvent }
  | { type: "decided"; id: string; decision: Decision }
  | { type: "decision-failed"; id: string }
  | { type: "answered"; id: string; answer: string }
  | { type: "notice"; error: string; code?: string }
  | { type: "connection-lost" };

let counter = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${counter++}`;

const text = (v: unknown): string | undefined =>
  v == null ? undefined : typeof v === "string" ? v : JSON.stringify(v, null, 2);

/** Hängt Text an die laufende Assistenten-Nachricht oder legt sie an. */
function withAssistant(items: Item[], fn: (m: Extract<Item, { kind: "message" }>) => void): Item[] {
  const last = items[items.length - 1];
  if (last && last.kind === "message" && last.role === "assistant" && last.streaming) {
    const copy = { ...last };
    fn(copy);
    return [...items.slice(0, -1), copy];
  }
  const fresh: Extract<Item, { kind: "message" }> = {
    kind: "message", id: uid("a"), role: "assistant", text: "", reasoning: "", streaming: true, images: [],
  };
  fn(fresh);
  return [...items, fresh];
}

const settle = (items: Item[]): Item[] =>
  items.map((i) => {
    if (i.kind === "message" && i.streaming) return { ...i, streaming: false };
    if (i.kind === "tool" && i.status === "running") return { ...i, status: "error" as const };
    return i;
  });

export function chatReducer(state: ChatState, a: Action): ChatState {
  switch (a.type) {
    case "reset":
      return initialState;
    case "history":
      return { ...initialState, items: a.items };
    case "user-sent":
      return {
        ...state, error: undefined, errorCode: undefined, usage: undefined, runStatus: "starting",
        items: [...state.items, { kind: "message", id: uid("u"), role: "user", text: a.text, reasoning: "", streaming: false, images: a.images }],
      };
    case "run-accepted":
      return { ...state, runId: a.runId, runStatus: "running" };
    case "run-error":
      return { ...state, runStatus: "failed", error: a.error, errorCode: undefined };
    case "connection-lost":
      return state.runStatus === "running" ? { ...state, runStatus: "lost", error: "Verbindung zu Hermes unterbrochen" } : state;
    case "decided":
      return { ...state, items: state.items.map((i) => (i.kind === "approval" && i.id === a.id ? { ...i, decision: a.decision } : i)) };
    case "decision-failed":
      return { ...state, items: state.items.map((i) => (i.kind === "approval" && i.id === a.id ? { ...i, decision: undefined } : i)) };
    case "notice":
      // Meldung ohne den Run als gescheitert zu markieren (z. B. Freigabe abgelehnt, Step-up nötig).
      return { ...state, error: a.error, errorCode: a.code };
    case "answered":
      return { ...state, items: state.items.map((i) => (i.kind === "clarify" && i.id === a.id ? { ...i, answer: a.answer } : i)) };
    case "event":
      return applyEvent(state, a.event);
  }
}

function applyEvent(s: ChatState, e: StreamEvent): ChatState {
  switch (e.type) {
    case "run.started":
      return { ...s, runStatus: "running" };
    case "message.delta":
      return { ...s, runStatus: "running", items: withAssistant(s.items, (m) => { m.text += e.text; }) };
    case "message.interim":
      return { ...s, items: withAssistant(s.items, (m) => { m.text += (m.text ? "\n\n" : "") + e.text; }) };
    case "reasoning.delta":
      return { ...s, items: withAssistant(s.items, (m) => { m.reasoning += e.text; }) };
    case "tool.started":
      return {
        ...s,
        // Ein Tool-Aufruf beendet den aktuellen Text-Abschnitt, damit die Reihenfolge stimmt.
        items: [...settleMessages(s.items), { kind: "tool", id: e.id, name: e.name, preview: text(e.preview), status: "running" }],
      };
    case "tool.completed": {
      const done = { status: e.ok ? ("ok" as const) : ("error" as const), durationMs: e.duration_ms ?? undefined, output: text(e.output) };
      const exists = s.items.some((i) => i.kind === "tool" && i.id === e.id);
      return {
        ...s,
        items: exists
          ? s.items.map((i) => (i.kind === "tool" && i.id === e.id ? { ...i, ...done } : i))
          : [...s.items, { kind: "tool", id: e.id, name: e.name, ...done }],
      };
    }
    case "approval.requested":
      return {
        ...s,
        items: [...settleMessages(s.items), {
          kind: "approval", id: uid("ap"), command: e.command, reason: e.reason, timeoutS: e.timeout_s,
          choices: e.choices, smartDenied: !!e.smart_denied,
        }],
      };
    case "approval.responded": {
      // Auch eine Antwort von anderswo (CLI, anderes Fenster) schließt die offene Anfrage.
      const open = [...s.items].reverse().find((i) => i.kind === "approval" && !i.decision);
      if (!open || !e.choice) return s;
      return { ...s, items: s.items.map((i) => (i === open && i.kind === "approval" ? { ...i, decision: e.choice! } : i)) };
    }
    case "clarify.requested":
      return { ...s, items: [...settleMessages(s.items), { kind: "clarify", id: uid("cl"), clarifyId: e.clarify_id ?? undefined, question: e.question, choices: e.choices ?? [] }] };
    case "run.completed": {
      // Ohne Textstrom (Anbieter ohne Streaming) steht die Antwort nur im Abschluss-Event.
      const lastUser = s.items.map((i) => i.kind === "message" && i.role === "user").lastIndexOf(true);
      const answered = s.items.slice(lastUser + 1).some((i) => i.kind === "message" && i.role === "assistant" && i.text);
      const items = !answered && e.text ? withAssistant(s.items, (m) => { m.text = e.text!; }) : s.items;
      return { ...s, runStatus: "done", usage: e.usage ?? undefined, items: settle(items) };
    }
    case "run.failed":
      return { ...s, runStatus: "failed", error: e.error, items: settle(s.items) };
    case "run.stopped":
      return { ...s, runStatus: "stopped", items: settle(s.items) };
    case "stream.error":
      return { ...s, runStatus: "lost", error: e.error, items: settle(s.items) };
    default:
      return s; // subagent.* und unknown: Phase 2 (Inspector)
  }
}

const settleMessages = (items: Item[]): Item[] =>
  items.map((i) => (i.kind === "message" && i.streaming ? { ...i, streaming: false } : i));

/** Verlauf aus /api/sessions/{id}/messages. Nur Nutzer- und Assistententext; Tool-Rollen entfallen. */
export function historyItems(payload: unknown): Item[] {
  const list = Array.isArray(payload) ? payload : (payload as { messages?: unknown[] } | null)?.messages ?? [];
  const items: Item[] = [];
  for (const raw of list as Array<Record<string, unknown>>) {
    const role = raw.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = raw.content;
    const body = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join("")
        : "";
    if (!body.trim()) continue;
    items.push({ kind: "message", id: uid("h"), role, text: body, reasoning: "", streaming: false, images: [] });
  }
  return items;
}

export function sessionList(payload: unknown): SessionSummary[] {
  const list = Array.isArray(payload) ? payload : (payload as { sessions?: unknown[]; items?: unknown[] } | null)?.sessions
    ?? (payload as { items?: unknown[] } | null)?.items ?? [];
  return (list as Array<Record<string, unknown>>)
    .filter((s) => typeof s.id === "string")
    .map((s) => ({
      id: s.id as string,
      title: String(s.title ?? s.name ?? "Ohne Titel"),
      updatedAt: (s.updated_at ?? s.last_active ?? s.updatedAt) as number | string | undefined,
      source: s.source as string | undefined,
    }));
}
