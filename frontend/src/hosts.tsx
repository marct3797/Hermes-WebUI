import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import { cached, invalidate } from "./dataCache";
import { poll } from "./poll";
import type { AgentRef, HostInfo, HostsResponse } from "./types";
import { labelFor, useUi } from "./ui";

type HostsState = {
  hosts?: HostInfo[];
  configError?: string | null;
  error?: string;
  refresh: () => void;
};

const Ctx = createContext<HostsState>({ refresh: () => undefined });
const POLL_MS = 30_000;

/** Hosts, Runtimes und Agents samt Status. Wird alle 30 s (nur bei sichtbarem Tab) und beim Zurückkehren ins Fenster aufgefrischt. */
export function HostsProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<HostsResponse>();
  const [error, setError] = useState<string>();
  const alive = useRef(true);

  // 5 s Dedupe: Start, Takt und Rückkehr in den Tab fragen sonst kurz hintereinander dasselbe ab.
  const load = useCallback(() => cached("hosts", 5_000, (s) => api.hosts(s))
    .then((r) => { if (alive.current) { setData(r); setError(undefined); } })
    .catch((e: Error) => { if (alive.current) setError(e.message); throw e; }), []);
  // Ausdrückliches Auffrischen (Knopf) soll nie einen alten Stand liefern.
  const refresh = useCallback(() => { invalidate("hosts"); load().catch(() => undefined); }, [load]);

  useEffect(() => {
    alive.current = true;
    load().catch(() => undefined);
    const stop = poll(load, POLL_MS);
    return () => { alive.current = false; stop(); };
  }, [load]);

  // Anzeigenamen aus der WebUI-Config gehen dem Ordnernamen aus Hermes vor.
  const { labels } = useUi();
  const hosts = useMemo(() => {
    if (!data || Object.keys(labels).length === 0) return data?.hosts;
    return data.hosts.map((h) => ({
      ...h,
      runtimes: h.runtimes.map((r) => ({
        ...r,
        agents: r.agents.map((a) => { const l = labelFor(labels, { host: h.id, runtime: r.id, agent: a.id }); return l ? { ...a, label: l } : a; }),
      })),
    }));
  }, [data, labels]);

  const value = useMemo(() => ({ hosts, configError: data?.config_error, error, refresh }), [hosts, data, error, refresh]);
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
