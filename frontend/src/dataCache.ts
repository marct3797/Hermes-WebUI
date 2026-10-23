/**
 * Gemeinsame Abfragen kurz zwischenspeichern: gleiche Schlüssel teilen sich eine Anfrage (Dedupe), frische Antworten kommen
 * aus dem Speicher, `peek` liefert den letzten Stand sofort (stale-while-revalidate: anzeigen, dann im Hintergrund auffrischen).
 * Eine geteilte Anfrage wird erst abgebrochen, wenn alle Wartenden abgebrochen haben (Seitenwechsel).
 */
type Flight = { promise: Promise<unknown>; ctl: AbortController; refs: number };

const done = new Map<string, { at: number; value: unknown }>();
const flights = new Map<string, Flight>();

const abortError = () => new DOMException("Abgebrochen", "AbortError");
export const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

export const peek = <T>(key: string): T | undefined => done.get(key)?.value as T | undefined;

/** Verwirft Einträge (und laufende Anfragen) deren Schlüssel mit `prefix` beginnt; nach Schreibzugriffen aufrufen. */
export function invalidate(prefix = ""): void {
  for (const k of [...done.keys()]) if (k.startsWith(prefix)) done.delete(k);
  for (const [k, f] of [...flights]) if (k.startsWith(prefix)) { flights.delete(k); f.ctl.abort(); }
}

export function cached<T>(key: string, ttlMs: number, load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const hit = done.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value as T);
  if (signal?.aborted) return Promise.reject(abortError());
  let flight = flights.get(key);
  if (!flight) {
    const ctl = new AbortController();
    const promise = load(ctl.signal).then((value) => {
      if (flights.get(key) === f) done.set(key, { at: Date.now(), value });
      return value;
    }).finally(() => { if (flights.get(key) === f) flights.delete(key); });
    const f: Flight = { promise, ctl, refs: 0 };
    promise.catch(() => undefined); // Fehler kommen bei den Wartenden an; hier nur kein "unhandled rejection"
    flights.set(key, flight = f);
  }
  const f = flight;
  f.refs++;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      if (--f.refs === 0) { f.ctl.abort(); if (flights.get(key) === f) flights.delete(key); }
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    f.promise.then(
      (v) => { signal?.removeEventListener("abort", onAbort); f.refs--; resolve(v as T); },
      (e) => { signal?.removeEventListener("abort", onAbort); f.refs--; reject(e); },
    );
  });
}

/** Nur für Tests. */
export const resetDataCache = () => { done.clear(); flights.clear(); };
