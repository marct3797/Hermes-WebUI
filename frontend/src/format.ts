/** Zahlen und Zeiten für die Anzeige: deutsches Format, Zahlen in Mono. */
import { getPreferences } from "./preferences";
import { t as tr } from "./i18n";

export const dec = (n: number, digits = 1) => n.toFixed(digits).replace(".", ",");

/** 3,2 s · 0,04 s · 1:05 min */
export function fmtDuration(ms: number): string {
  if (ms < 100) return `${dec(ms / 1000, 2)} s`;
  if (ms < 60_000) return `${dec(ms / 1000, 1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}:${String(s).padStart(2, "0")} min`;
}

/** m:ss, z. B. für Countdowns und die Laufzeit eines Runs. */
export function fmtClock(totalSeconds: number): string {
  const t = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** Markdown als einzeiliger Klartext für Vorschauen: Codeblöcke werden zu „[Code]“, Auszeichnungen fallen weg. */
export const plainPreview = (md: string) =>
  md.replace(/```[\s\S]*?```/g, " [Code] ").replace(/[*_`#>~]/g, "").replace(/\s+/g, " ").trim();

export const fmtCount = (n: number) => n.toLocaleString("de-DE");

export const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", hour12: getPreferences().timeFormat === "12h" });
export const fmtTimeSec = (ms: number) => new Date(ms).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: getPreferences().timeFormat === "12h" });
export const fmtDay = (ms: number) => new Date(ms).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });

/** Epoche in Sekunden oder Millisekunden sowie ISO-Texte; alles andere ergibt `undefined`. */
export function toMs(t: number | string | undefined): number | undefined {
  if (typeof t === "number" && Number.isFinite(t)) return t < 1e12 ? t * 1000 : t;
  if (typeof t === "string") {
    const n = Date.parse(t);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

export type DayGroup = "today" | "yesterday" | "older";

export function dayGroup(ms: number | undefined, now = Date.now()): DayGroup {
  if (ms === undefined) return "older";
  const start = new Date(now).setHours(0, 0, 0, 0);
  if (ms >= start) return "today";
  if (ms >= start - 86_400_000) return "yesterday";
  return "older";
}

export const DAY_LABEL: Record<DayGroup, string> = { today: "Heute", yesterday: "Gestern", older: "Älter" };

/** Symbol je Werkzeug; unbekannte Namen bekommen den Schraubenschlüssel. */
export function toolIcon(name: string): string {
  const n = name.toLowerCase();
  if (/terminal|shell|bash|exec|command/.test(n)) return "terminal";
  if (/file|patch|edit|write|read|ls|glob|grep/.test(n)) return "file";
  if (/web|browser|search|fetch|http|url/.test(n)) return "globe";
  if (/delegate|subagent|agent|task/.test(n)) return "cpu";
  if (/memory|recall|remember/.test(n)) return "memory";
  return "wrench";
}

/** vor 5 Min · vor 2 Std · vor 3 T; unter einer Minute „gerade eben“. */
export function fmtAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return tr("gerade eben");
  if (s < 3600) return `vor ${Math.floor(s / 60)} Min`;
  if (s < 86_400) return `vor ${Math.floor(s / 3600)} Std`;
  return `vor ${Math.floor(s / 86_400)} T`;
}

/** Do 22.10. */
export function fmtDate(ms: number): string {
  const d = new Date(ms);
  const day = d.toLocaleDateString("de-DE", { weekday: "short" }).replace(".", "");
  return `${day} ${d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" })}`;
}
