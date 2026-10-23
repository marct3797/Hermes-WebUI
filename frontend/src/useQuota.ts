import { useEffect, useRef, useState } from "react";
import { useAsync } from "./useAsync";

/**
 * Lädt Kontingente, erneuert sie jede Minute (nur bei sichtbarem Tab) und bei `reload` mit erzwungener Abfrage.
 * Die letzte Antwort bleibt beim Neuladen stehen, damit nichts springt.
 */
export function useQuota<T>(load: (refresh: boolean) => Promise<T>, deps: readonly unknown[]) {
  const [tick, setTick] = useState(0);
  const force = useRef(false);
  const last = useRef<T>();
  const state = useAsync(() => { const refresh = force.current; force.current = false; return load(refresh); }, [...deps, tick]);
  if (state.data) last.current = state.data;
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") setTick((n) => n + 1); }, 60_000);
    return () => clearInterval(t);
  }, []);
  return { data: state.data ?? last.current, error: state.error, loading: state.loading, reload: () => { force.current = true; setTick((n) => n + 1); } };
}
