/** Nächste Läufe eines 5-Felder-Cron-Ausdrucks (Zahlen, `*`, Listen, Bereiche, Schritte) in der Zeitzone des Browsers; sonst `null`.
 * Hermes rechnet in seiner eigenen Zeitzone: die Vorschau ist eine Orientierung, die verbindliche Zeit zeigt die Liste nach dem Speichern. */
const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function field(src: string, [lo, hi]: [number, number]): Set<number> | null {
  const out = new Set<number>();
  for (const part of src.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[2] ? Number(m[2]) : 1;
    const [a, b] = m[1] === "*" ? [lo, hi] : m[1].includes("-") ? m[1].split("-").map(Number) : [Number(m[1]), m[2] ? hi : Number(m[1])];
    if (step < 1 || a < lo || b > hi || a > b) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

export function nextRuns(expr: string, from: Date, count = 3): Date[] | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = parts.map((p, i) => field(p, RANGES[i]));
  if (sets.some((s) => !s)) return null;
  const [min, hour, dom, mon, dow] = sets as Set<number>[];
  if (dow.has(7)) dow.add(0);
  const domAny = parts[2] === "*", dowAny = parts[4] === "*";
  const out: Date[] = [];
  const t = new Date(from); t.setSeconds(0, 0); t.setMinutes(t.getMinutes() + 1);
  for (let guard = 0; out.length < count && guard < 600_000; guard++) {
    const dayOk = mon.has(t.getMonth() + 1) && (domAny || dowAny ? dom.has(t.getDate()) && dow.has(t.getDay()) : dom.has(t.getDate()) || dow.has(t.getDay()));
    if (!dayOk) { t.setHours(24, 0, 0, 0); continue; }  // ganzen Tag überspringen
    if (!hour.has(t.getHours())) { t.setHours(t.getHours() + 1, 0, 0, 0); continue; }
    if (min.has(t.getMinutes())) out.push(new Date(t));
    t.setMinutes(t.getMinutes() + 1);
  }
  return out.length ? out : null;
}

/** Lesbare Beschreibung für Intervall-Schreibweisen (`30m`, `every 2h`); sonst `null`. */
export function describeInterval(s: string): string | null {
  const m = /^(?:every\s+)?(\d+)\s*([mhd])$/i.exec(s.trim());
  if (!m) return null;
  const unit = { m: ["Minute", "Minuten"], h: ["Stunde", "Stunden"], d: ["Tag", "Tage"] }[m[2].toLowerCase() as "m"];
  return Number(m[1]) === 1 ? `jede ${unit[0]}` : `alle ${m[1]} ${unit[1]}`;
}
