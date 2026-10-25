import { agentKey } from "./router";
import type { Conv, Snapshot } from "./runStore";
import type { AgentRef, Item } from "./types";
import { t } from "./i18n";

type Approval = Extract<Item, { kind: "approval" }>;
type Clarify = Extract<Item, { kind: "clarify" }>;

/** Etwas, das die Person entscheiden oder wissen muss. `id` ist über alle Unterhaltungen eindeutig. */
export type Need = {
  id: string;
  convKey: string;
  agent: AgentRef;
  sessionId?: string;
  runId?: string;
  /** Erste Nutzernachricht der Unterhaltung als Anhalt, worum es geht. */
  topic?: string;
  /** Seit wann die Person gefragt ist (ms). */
  since: number;
} & (
  | { kind: "approval"; item: Approval; steps: Item[] }
  | { kind: "clarify"; item: Clarify; steps: Item[] }
  | { kind: "failed" | "lost"; error: string; steps: Item[] }
);

const topicOf = (c: Conv) => {
  const first = c.state.items.find((i) => i.kind === "message" && i.role === "user");
  return first?.kind === "message" ? first.text.split("\n")[0].slice(0, 80) : undefined;
};

const lastSteps = (c: Conv) => c.state.items.filter((i) => i.kind === "tool").slice(-4);

/** Offene Freigaben und Rückfragen laufender Runs, danach gescheiterte und getrennte Runs; die dringendsten zuerst. */
export function needs(snap: Snapshot): Need[] {
  const out: Need[] = [];
  for (const c of snap.convs.values()) {
    const base = { convKey: c.key, agent: c.agent, sessionId: c.sessionId, runId: c.state.runId, topic: topicOf(c), steps: lastSteps(c) };
    const active = c.state.runStatus === "running" || c.state.runStatus === "starting";
    for (const item of c.state.items) {
      if (active && item.kind === "approval" && !item.decision) out.push({ ...base, id: `${c.key}:${item.id}`, kind: "approval", item, since: item.at });
      else if (active && item.kind === "clarify" && !item.answer) out.push({ ...base, id: `${c.key}:${item.id}`, kind: "clarify", item, since: item.at ?? c.touched });
    }
    const failed = c.state.runStatus === "failed" || c.state.runStatus === "lost";
    const id = `${c.key}:${c.state.runId ?? "start"}:${c.state.runStatus}`;
    if (failed && !snap.dismissed.has(id) && !c.stale) {
      out.push({ ...base, id, kind: c.state.runStatus as "failed" | "lost", error: c.state.error ?? t("Der Run ist fehlgeschlagen."), since: c.touched });
    }
  }
  const rank = (n: Need) => (n.kind === "approval" ? 0 : n.kind === "clarify" ? 1 : 2);
  const expires = (n: Need) => (n.kind === "approval" ? n.item.at + n.item.timeoutS * 1000 : Infinity);
  return out.sort((a, b) => rank(a) - rank(b) || expires(a) - expires(b) || a.since - b.since);
}

/** Ein Run, der gerade läuft (auch wenn er auf die Person wartet). */
export type LiveRun = {
  convKey: string;
  agent: AgentRef;
  sessionId?: string;
  runId?: string;
  startedAt?: number;
  waiting: "approval" | "clarify" | null;
  /** Was der Run gerade tut: laufendes Tool oder „streamt“. */
  activity: string;
  topic?: string;
  tokens?: number;
};

export function liveRuns(snap: Snapshot): LiveRun[] {
  const out: LiveRun[] = [];
  for (const c of snap.convs.values()) {
    const s = c.state;
    if (s.runStatus !== "running" && s.runStatus !== "starting") continue;
    const waiting = s.items.some((i) => i.kind === "approval" && !i.decision) ? "approval"
      : s.items.some((i) => i.kind === "clarify" && !i.answer) ? "clarify" : null;
    const tool = [...s.items].reverse().find((i) => i.kind === "tool" && i.status === "running");
    const last = s.items[s.items.length - 1];
    const activity = waiting === "approval" ? t("wartet auf Freigabe")
      : waiting === "clarify" ? t("wartet auf Antwort")
      : tool?.kind === "tool" ? [tool.name, (tool.preview ?? "").split("\n")[0]].filter(Boolean).join(" · ")
      : last?.kind === "message" && last.role === "assistant" && last.streaming ? t("streamt") : s.runStatus === "starting" ? t("startet …") : t("arbeitet …");
    const tokens = s.usage ? (s.usage.total_tokens ?? (s.usage.input_tokens ?? 0) + (s.usage.output_tokens ?? 0)) : undefined;
    out.push({ convKey: c.key, agent: c.agent, sessionId: c.sessionId, runId: s.runId, startedAt: s.startedAt, waiting, activity, topic: topicOf(c), tokens });
  }
  return out.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

/** Zustand eines Agents für Karte, Rail und Seitenleiste. */
export type AgentActivity = { running: number; waiting: number; failed: number; activity?: string; startedAt?: number; last?: LiveRun };

export function activityByAgent(snap: Snapshot): Map<string, AgentActivity> {
  const map = new Map<string, AgentActivity>();
  const get = (a: AgentRef) => {
    const k = agentKey(a);
    let v = map.get(k);
    if (!v) { v = { running: 0, waiting: 0, failed: 0 }; map.set(k, v); }
    return v;
  };
  for (const r of liveRuns(snap)) {
    const v = get(r.agent);
    v.running += 1;
    v.last = r;
    v.activity = r.activity;
    v.startedAt = Math.min(v.startedAt ?? Infinity, r.startedAt ?? Infinity);
  }
  for (const n of needs(snap)) {
    const v = get(n.agent);
    if (n.kind === "failed" || n.kind === "lost") v.failed += 1;
    else v.waiting += 1;
  }
  return map;
}

/** Sekunden bis eine Freigabe erlischt (negativ: abgelaufen); andere Arten haben keine Frist. */
export function secondsLeft(n: Need, now: number): number | undefined {
  return n.kind === "approval" ? (n.item.at + n.item.timeoutS * 1000 - now) / 1000 : undefined;
}

/** Kennung des Eintrags innerhalb seiner Unterhaltung (für decide/answer am Store). */
export const itemIdOf = (n: Need) => n.id.slice(n.convKey.length + 1);
