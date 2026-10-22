import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "./api";
import { sessionList } from "./chatReducer";
import type { AgentRef, RunStatus, SessionSummary } from "./types";

/** Zustand des Runs in der geöffneten Chat-Ansicht, damit Rail und Session-Liste ihn anzeigen können. */
export type RunInfo = { status: RunStatus; waiting: boolean };
export const NO_RUN: RunInfo = { status: "idle", waiting: false };

type ShellState = {
  openMenu: () => void;
  sessions: SessionSummary[];
  sessionsLoading: boolean;
  refreshSessions: () => void;
  run: RunInfo;
  setRun: (r: RunInfo) => void;
};

export const ShellContext = createContext<ShellState>({
  openMenu: () => undefined, sessions: [], sessionsLoading: false, refreshSessions: () => undefined,
  run: NO_RUN, setRun: () => undefined,
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
