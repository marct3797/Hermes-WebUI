import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { cached, invalidate, isAbort, peek } from "./dataCache";
import { sessionList } from "./chatReducer";
import { toMs } from "./format";
import { agentKey } from "./router";
import { useRunStore } from "./runs";
import type { AgentRef, SessionSummary } from "./types";

export type LastChat = { loaded: boolean; failed?: boolean; last?: SessionSummary; at?: number };

const TTL_MS = 10_000;
const keyOf = (a: AgentRef) => `sessions:${agentKey(a)}`;

/** Letzte Session je Agent (für die Karten des Cockpits). Zeigt sofort den letzten Stand (falls vorhanden), frischt im Hintergrund
 * auf (Antworten bis 10 s alt werden wiederverwendet) und lädt nach jedem beendeten Run neu. Beim Verlassen der Seite werden
 * laufende Abfragen abgebrochen. */
export function useAgentSessions(agents: AgentRef[]): Map<string, LastChat> {
  const [data, setData] = useState<Map<string, LastChat>>(new Map());
  const store = useRunStore();
  const wanted = agents.map(agentKey).join("|");
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    let stale = false;
    const ctl = new AbortController();
    const summarize = (r: unknown): LastChat => {
      const list = sessionList(r);
      const last = [...list].sort((x, y) => (toMs(y.updatedAt) ?? 0) - (toMs(x.updatedAt) ?? 0))[0];
      return { loaded: true, last, at: toMs(last?.updatedAt) };
    };
    const put = (a: AgentRef, v: LastChat) => { if (!stale && alive.current) setData((m) => new Map(m).set(agentKey(a), v)); };
    const load = (a: AgentRef) =>
      cached(keyOf(a), TTL_MS, (s) => api.sessions(a, 0, 30, s), ctl.signal)
        .then((r) => put(a, summarize(r)))
        .catch((e) => { if (!isAbort(e)) put(a, { loaded: true, failed: true }); });
    agents.forEach((a) => { const old = peek(keyOf(a)); if (old) put(a, summarize(old)); void load(a); });
    const off = store.onRunEnd((a) => { if (agents.some((x) => agentKey(x) === agentKey(a))) { invalidate(keyOf(a)); void load(a); } });
    return () => { stale = true; ctl.abort(); off(); };
    // `agents` ist je Render ein neues Array; maßgeblich ist die Kennung der Agents.
  }, [wanted, store]);

  return data;
}
