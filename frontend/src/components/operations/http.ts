import { t } from "../../i18n";
export const enc = encodeURIComponent;

export async function operationsHttp<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { "X-Requested-With": "hermes-webui", ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  if (!response.ok) {
    const label = response.status === 401 ? t("Anmeldung erforderlich") : response.status === 403 ? t("Berechtigung fehlt oder erneute Anmeldung erforderlich") : response.status === 501 ? t("Nicht unterstützt") : response.status === 503 ? t("Nicht eingerichtet oder nicht erreichbar") : t("API-Anfrage fehlgeschlagen");
    throw new Error(`${label} (HTTP ${response.status}).`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export type Schedule = string | { kind: string; expr?: string; minutes?: number; display?: string };
/** Hermes liefert den Zeitplan als Objekt (cron oder interval), ältere Mocks als String. */
export function scheduleText(s: Schedule | null | undefined): string {
  if (typeof s === "string") return s || t("Kein Zeitplan gemeldet");
  return text(s?.display) || text(s?.expr) || (typeof s?.minutes === "number" ? t("alle {minutes} Minuten", { minutes: s.minutes }) : t("Kein Zeitplan gemeldet"));
}
/** Nur der Cron-Ausdruck ist bearbeitbar; Intervalle werden angezeigt. */
export function editableSchedule(s: Schedule | null | undefined): string | undefined {
  return typeof s === "string" ? s : s?.kind === "cron" && typeof s.expr === "string" ? s.expr : undefined;
}
/** API-Felder nie ungeprüft als React-Kind: Objekte würden die ganze Seite abstürzen lassen. */
export const text = (v: unknown): string => typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "";

export type Availability = { source?: string; available?: boolean; configured?: boolean; supported?: boolean; reason?: string; warnings?: string[]; truncated?: boolean };
export type Entry = { id: string; assignee?: string; version?: string; title?: string; transitions?: string[]; name?: string; label?: string; description?: string; enabled?: boolean; status?: string; actions?: string[] };
export type Source = Entry & { url?: string; reviewed?: boolean; installable?: boolean; trust?: string; kind?: string; requirements?: string[] };
export type Catalog = Availability & { profiles?: { id: string }[]; sources?: Source[] };
export type Listing = Availability & { actions?: string[]; note?: string; items?: Entry[]; content?: string; redacted?: boolean; columns?: string[]; tasks?: (Entry & { title: string; status: string; transitions?: string[] })[]; jobs?: (Entry & { schedule?: Schedule; paused?: boolean })[] };
export const labels: Record<string, string> = { enable: "Aktivieren", disable: "Deaktivieren", install: "Installieren", pause: "Pausieren", resume: "Fortsetzen", edit: "Bearbeiten" };

export function unavailable(data: Availability): string | undefined {
  if (data.configured === false) return t("Nicht eingerichtet: {konfiguriert}", { konfiguriert: data.reason ?? t("Host-Daemon nicht konfiguriert.") });
  if (data.supported === false || data.available === false) return t("Nicht unterstützt: {gbar}", { gbar: data.reason ?? t("Diese Funktion ist nicht verfügbar.") });
}
