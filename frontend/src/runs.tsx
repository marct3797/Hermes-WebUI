import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { activityByAgent, liveRuns, needs as needsOf, type AgentActivity, type LiveRun, type Need } from "./attention";
import { createRunStore, type RunStore, type Snapshot } from "./runStore";

const Ctx = createContext<RunStore | null>(null);

/** Hält die Run-Zustände über Seitenwechsel hinweg (siehe runStore.ts). */
export function RunsProvider({ children, store }: { children: ReactNode; store?: RunStore }) {
  const [own] = useState(() => store ?? createRunStore());
  useEffect(() => () => own.dispose(), [own]);
  return <Ctx.Provider value={own}>{children}</Ctx.Provider>;
}

export function useRunStore(): RunStore {
  const store = useContext(Ctx);
  if (!store) throw new Error("RunsProvider fehlt");
  return store;
}

/** Alle Unterhaltungen und das Entscheidungs-Log; ändert sich bei jedem Ereignis eines Runs. */
export function useRunSnapshot(): Snapshot {
  const store = useRunStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

export type Activity = { needs: Need[]; live: LiveRun[]; byAgent: Map<string, AgentActivity> };

/** Was gerade läuft und was die Person braucht, abgeleitet aus dem Zustand aller Unterhaltungen. */
export function useActivity(): Activity {
  const snap = useRunSnapshot();
  return useMemo(() => ({ needs: needsOf(snap), live: liveRuns(snap), byAgent: activityByAgent(snap) }), [snap]);
}
