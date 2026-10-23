import { useEffect, useState } from "react";

export type Async<T> = { data?: T; error?: string; loading: boolean };

/** Lädt beim Wechsel der Abhängigkeiten neu; eine spät eintreffende Antwort der alten Anfrage wird verworfen. */
export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): Async<T> {
  const [state, setState] = useState<Async<T>>({ loading: true });
  useEffect(() => {
    let stale = false;
    setState({ loading: true });
    load().then(
      (data) => { if (!stale) setState({ data, loading: false }); },
      (e: unknown) => { if (!stale) setState({ error: e instanceof Error ? e.message : String(e), loading: false }); },
    );
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `load` ist pro Render neu, maßgeblich sind die genannten Abhängigkeiten
  }, deps);
  return state;
}
