/** Neue Logzeilen an die vorhandenen hängen: das Dashboard liefert immer das aktuelle Ende, also überlappt der Anfang der neuen Antwort das Ende der alten. */
export function mergeLines(old: string[], fresh: string[], max = 5000): string[] {
  if (old.length === 0) return fresh;
  let k = Math.min(old.length, fresh.length);
  for (; k > 0; k--) {
    let same = true;
    for (let i = 0; i < k && same; i++) same = old[old.length - k + i] === fresh[i];
    if (same) break;
  }
  const out = [...old, ...fresh.slice(k)];
  return out.length > max ? out.slice(out.length - max) : out;
}

const LEVEL = /^\S+ \S+ (DEBUG|INFO|WARNING|ERROR|CRITICAL)\b/;
/** Stufe je Zeile; Zeilen ohne eigene Stufe (z. B. Traceback) erben die der vorigen. */
export function levels(lines: string[]): (string | null)[] {
  let cur: string | null = null;
  return lines.map((l) => { const m = LEVEL.exec(l); if (m) cur = m[1]; return cur; });
}
