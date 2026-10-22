import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "./api";
import { sessionList } from "./chatReducer";
import type { AgentRef, SessionSummary } from "./types";

type ShellState = {
  openMenu: () => void;
  sessions: SessionSummary[];
  sessionsLoading: boolean;
  refreshSessions: () => void;
};

export const ShellContext = createContext<ShellState>({
  openMenu: () => undefined, sessions: [], sessionsLoading: false, refreshSessions: () => undefined,
});

export const useShell = () => useContext(ShellContext);

/** Session-Liste des Agents, der gerade geöffnet ist. `agent` muss stabil sein (useAgentRef). */
export function useSessions(agent?: AgentRef) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(() => {
    if (!agent) return;
    api.sessions(agent)
      .then((r) => setSessions(sessionList(r)))
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, [agent]);

  useEffect(() => {
    setSessions([]);
    if (!agent) { setLoading(false); return; }
    setLoading(true);
    refresh();
  }, [agent, refresh]);

  return { sessions, loading, refresh };
}
