import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { sessionRows } from "./chatReducer";
import { agentKey } from "./router";
import { useRunStore } from "./runs";
import { sessionStats, type SessionStat } from "./stats";
import type { AgentRef } from "./types";

export const USAGE_PAGE = 100; // so viele Sessions je Agent liest die Auswertung (das BFF erlaubt höchstens 100)

export type AgentUsage = { loaded: boolean; failed?: boolean; stats: SessionStat[]; rows: number };

/** Sessions aller Agents als Kennzahlen. Lädt einmal je Agent und nach jedem beendeten Run neu. */
export function useUsage(agents: AgentRef[]): { byAgent: Map<string, AgentUsage>; stats: SessionStat[]; loading: boolean } {
  const [data, setData] = useState<Map<string, AgentUsage>>(new Map());
  const store = useRunStore();
  const wanted = agents.map(agentKey).join("|");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    let stale = false;
    const load = (a: AgentRef) =>
      api.sessions(a, 0, USAGE_PAGE)
        .then((r): AgentUsage => ({ loaded: true, stats: sessionStats(a.agent, r), rows: sessionRows(r) }))
        .catch((): AgentUsage => ({ loaded: true, failed: true, stats: [], rows: 0 }))
        .then((v) => { if (!stale && alive.current) setData((m) => new Map(m).set(agentKey(a), v)); });
    agents.forEach((a) => { void load(a); });
    const off = store.onRunEnd((a) => { if (agents.some((x) => agentKey(x) === agentKey(a))) void load(a); });
    return () => { stale = true; off(); };
    // `agents` ist je Render ein neues Array; maßgeblich ist die Kennung der Agents.
  }, [wanted, store]);

  const stats = useMemo(() => [...data.values()].flatMap((d) => d.stats), [data]);
  const loading = agents.length > 0 && agents.some((a) => !data.get(agentKey(a))?.loaded);
  return { byAgent: data, stats, loading };
}
