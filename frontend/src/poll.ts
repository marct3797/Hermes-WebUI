/**
 * Wiederholt `fn` im Takt `ms`, aber nur bei sichtbarem Tab. Beim Zurückkehren in den Tab läuft `fn` sofort einmal.
 * Schlägt `fn` fehl (Promise lehnt ab), verdoppelt sich der Abstand bis `ms * 8`; ein Erfolg setzt ihn zurück.
 * Der erste Aufruf gehört dem Aufrufer (er lädt beim Start selbst). Gibt die Abmeldung zurück.
 */
export function poll(fn: () => Promise<unknown>, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = ms;
  let running = false;
  let stopped = false;
  const visible = () => document.visibilityState === "visible";
  const schedule = () => {
    clearTimeout(timer);
    if (!stopped && visible()) timer = setTimeout(() => { void tick(); }, delay);
  };
  const tick = async () => {
    if (running) return; // keine Doppelabfrage, solange die letzte läuft
    running = true;
    try { await fn(); delay = ms; } catch { delay = Math.min(delay * 2, ms * 8); } finally { running = false; schedule(); }
  };
  const onVisibility = () => { if (visible()) void tick(); else clearTimeout(timer); };
  document.addEventListener("visibilitychange", onVisibility);
  schedule();
  return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibility); };
}
