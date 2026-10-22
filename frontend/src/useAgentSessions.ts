import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { sessionList } from "./chatReducer";
import { toMs } from "./format";
import { agentKey } from "./router";
import { useRunStore } from "./runs";
import type { AgentRef, SessionSummary } from "./types";

export type LastChat = { loaded: boolean; failed?: boolean; last?: SessionSummary; at?: number };

/** Letzte Session je Agent (für die Karten des Cockpits). Lädt einmal je Agent und nach jedem beendeten Run neu. */
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
    const load = (a: AgentRef) =>
      api.sessions(a)
        .then((r): LastChat => {
          const list = sessionList(r);
          const last = [...list].sort((x, y) => (toMs(y.updatedAt) ?? 0) - (toMs(x.updatedAt) ?? 0))[0];
          return { loaded: true, last, at: toMs(last?.updatedAt) };
        })
        .catch((): LastChat => ({ loaded: true, failed: true }))
        .then((v) => { if (!stale && alive.current) setData((m) => new Map(m).set(agentKey(a), v)); });
    agents.forEach((a) => { void load(a); });
    const off = store.onRunEnd((a) => { if (agents.some((x) => agentKey(x) === agentKey(a))) void load(a); });
    return () => { stale = true; off(); };
    // `agents` ist je Render ein neues Array; maßgeblich ist die Kennung der Agents.
  }, [wanted, store]);

  return data;
}
