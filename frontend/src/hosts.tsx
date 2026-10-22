import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import type { AgentRef, HostInfo, HostsResponse } from "./types";

type HostsState = {
  hosts?: HostInfo[];
  configError?: string | null;
  error?: string;
  refresh: () => void;
};

const Ctx = createContext<HostsState>({ refresh: () => undefined });
const POLL_MS = 30_000;

/** Hosts, Runtimes und Agents samt Status. Wird alle 30 s und beim Zurückkehren ins Fenster aufgefrischt. */
export function HostsProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<HostsResponse>();
  const [error, setError] = useState<string>();
  const alive = useRef(true);

  const refresh = useCallback(() => {
    api.hosts()
      .then((r) => { if (alive.current) { setData(r); setError(undefined); } })
      .catch((e: Error) => { if (alive.current) setError(e.message); });
  }, []);

  useEffect(() => {
    alive.current = true;
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    const onFocus = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onFocus);
    return () => { alive.current = false; clearInterval(timer); document.removeEventListener("visibilitychange", onFocus); };
  }, [refresh]);

  const value = useMemo(() => ({ hosts: data?.hosts, configError: data?.config_error, error, refresh }), [data, error, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useHosts = () => useContext(Ctx);

export type ResolvedAgent = { host: HostInfo; runtimeLabel: string; runtimeOnline: boolean; label: string; ref: AgentRef };

/** Sucht den Agent einer URL in der Registry. `undefined` solange geladen wird, `null` wenn es ihn nicht (mehr) gibt. */
export function useResolvedAgent(ref?: AgentRef): ResolvedAgent | null | undefined {
  const { hosts } = useHosts();
  if (!hosts || !ref) return undefined;
  const host = hosts.find((h) => h.id === ref.host);
  const runtime = host?.runtimes.find((r) => r.id === ref.runtime);
  const agent = runtime?.agents.find((a) => a.id === ref.agent);
  return host && runtime && agent
    ? { host, runtimeLabel: runtime.label, runtimeOnline: runtime.status === "online", label: agent.label, ref }
    : null;
}

/** Stabiles AgentRef-Objekt je Kennung, damit Effekte nicht bei jedem Render neu laufen. */
export function useAgentRef(ref?: AgentRef): AgentRef | undefined {
  const host = ref?.host, runtime = ref?.runtime, agent = ref?.agent;
  return useMemo(() => (host && runtime && agent ? { host, runtime, agent } : undefined), [host, runtime, agent]);
}
