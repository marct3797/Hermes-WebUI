import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { sessionList, sessionRows, sessionsHaveMore } from "./chatReducer";
import type { AgentRef, SessionSummary } from "./types";

export const SESSION_PAGE = 30;

type ShellState = {
  openMenu: () => void;
  sessions: SessionSummary[];
  sessionsLoading: boolean;
  refreshSessions: () => void;
  hasMoreSessions?: boolean;
  loadingMoreSessions?: boolean;
  loadMoreSessions?: () => void;
  renameSession?: (id: string, title: string) => Promise<void>;
  deleteSession?: (id: string) => Promise<void>;
};

export const ShellContext = createContext<ShellState>({
  openMenu: () => undefined, sessions: [], sessionsLoading: false, refreshSessions: () => undefined,
});

export const useShell = () => useContext(ShellContext);

/** Session-Liste des Agents, der gerade geöffnet ist, seitenweise nachladbar. `agent` muss stabil sein (useAgentRef). */
export function useSessions(agent?: AgentRef) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  // Geladene Zeilen, wie Hermes sie zählt (ausgeblendete und archivierte inbegriffen): Versatz für die nächste Seite,
  // und ein Auffrischen lädt so viele wieder, statt die Liste auf Seite 1 zu kürzen.
  const rawOffset = useRef(0);

  const refresh = useCallback(() => {
    if (!agent) return;
    const limit = Math.min(100, Math.max(SESSION_PAGE, rawOffset.current));
    api.sessions(agent, 0, limit)
      .then((r) => { rawOffset.current = sessionRows(r); setSessions(sessionList(r)); setHasMore(sessionsHaveMore(r, limit)); })
      .catch(() => { rawOffset.current = 0; setSessions([]); setHasMore(false); })
      .finally(() => setLoading(false));
  }, [agent]);

  useEffect(() => {
    setSessions([]);
    setHasMore(false);
    rawOffset.current = 0;
    if (!agent) { setLoading(false); return; }
    setLoading(true);
    refresh();
  }, [agent, refresh]);

  const loadMore = useCallback(() => {
    if (!agent || loadingMore) return;
    setLoadingMore(true);
    api.sessions(agent, rawOffset.current, SESSION_PAGE)
      .then((r) => {
        rawOffset.current += sessionRows(r);
        setSessions((cur) => {
          const seen = new Set(cur.map((s) => s.id));
          return [...cur, ...sessionList(r).filter((s) => !seen.has(s.id))];
        });
        setHasMore(sessionsHaveMore(r, SESSION_PAGE));
      })
      .catch(() => setHasMore(false))
      .finally(() => setLoadingMore(false));
  }, [agent, loadingMore]);

  const rename = useCallback(async (id: string, title: string) => {
    if (!agent) return;
    await api.renameSession(agent, id, title);
    setSessions((cur) => cur.map((s) => (s.id === id ? { ...s, title } : s)));
  }, [agent]);

  const remove = useCallback(async (id: string) => {
    if (!agent) return;
    await api.deleteSession(agent, id);
    setSessions((cur) => cur.filter((s) => s.id !== id));
  }, [agent]);

  return { sessions, loading, loadingMore, hasMore, refresh, loadMore, rename, remove };
}
