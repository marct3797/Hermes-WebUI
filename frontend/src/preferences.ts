import { useMemo, useSyncExternalStore } from "react";

export const EFFORT_VALUES = ["agent", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type HostDefaults = { effort: typeof EFFORT_VALUES[number]; workspace: string };
export type Preferences = {
  enterSends: boolean; autoScroll: boolean; confirmApprovals: boolean;
  compact: boolean; timeFormat: "24h" | "12h"; reducedMotion: boolean;
  approvalDesktop: boolean; approvalSound: boolean;
  hosts: Record<string, HostDefaults>;
};
const KEY = "hermes.preferences";
const CHANGED = "hermes-preferences-changed";
const DEFAULTS: Preferences = {
  enterSends: true, autoScroll: true, confirmApprovals: false,
  compact: false, timeFormat: "24h", reducedMotion: false,
  approvalDesktop: false, approvalSound: false, hosts: {},
};
const read = () => { try { return localStorage.getItem(KEY) ?? "{}"; } catch { return "{}"; } };
function parse(raw: string): Preferences {
  let v: Record<string, unknown>;
  try { const decoded = JSON.parse(raw); v = decoded && typeof decoded === "object" && !Array.isArray(decoded) ? decoded : {}; } catch { v = {}; }
  const result = { ...DEFAULTS, hosts: {} as Preferences["hosts"] };
  for (const key of ["enterSends", "autoScroll", "confirmApprovals", "compact", "reducedMotion", "approvalDesktop", "approvalSound"] as const) {
    if (typeof v[key] === "boolean") result[key] = v[key];
  }
  if (v.timeFormat === "12h") result.timeFormat = "12h";
  if (v.hosts && typeof v.hosts === "object" && !Array.isArray(v.hosts)) {
    for (const [host, row] of Object.entries(v.hosts)) {
      if (!row || typeof row !== "object") continue;
      result.hosts[host] = { effort: EFFORT_VALUES.includes(row.effort) ? row.effort : "agent", workspace: typeof row.workspace === "string" ? row.workspace : "" };
    }
  }
  return result;
}
export const getPreferences = () => parse(read());
export function savePreferences(patch: Partial<Preferences>) {
  // Keine Erfolgsmeldung bei gesperrtem Speicher: der Aufrufer zeigt den Fehler.
  localStorage.setItem(KEY, JSON.stringify({ ...getPreferences(), ...patch }));
  window.dispatchEvent(new Event(CHANGED));
}
const subscribe = (fn: () => void) => {
  window.addEventListener(CHANGED, fn); window.addEventListener("storage", fn);
  return () => { window.removeEventListener(CHANGED, fn); window.removeEventListener("storage", fn); };
};
export function usePreferences() {
  const raw = useSyncExternalStore(subscribe, read);
  return useMemo(() => parse(raw), [raw]);
}
