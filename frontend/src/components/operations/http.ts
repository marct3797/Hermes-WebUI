export const enc = encodeURIComponent;

export async function operationsHttp<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { "X-Requested-With": "hermes-webui", ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  if (!response.ok) {
    const label = response.status === 401 ? "Anmeldung erforderlich" : response.status === 403 ? "Berechtigung fehlt oder erneute Anmeldung erforderlich" : response.status === 501 ? "Nicht unterstützt" : response.status === 503 ? "Nicht eingerichtet oder nicht erreichbar" : "API-Anfrage fehlgeschlagen";
    throw new Error(`${label} (HTTP ${response.status}).`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export type Availability = { available?: boolean; configured?: boolean; supported?: boolean; reason?: string; warnings?: string[]; truncated?: boolean };
export type Entry = { id: string; title?: string; transitions?: string[]; name?: string; label?: string; description?: string; enabled?: boolean; status?: string; actions?: string[] };
export type Source = Entry & { url?: string; reviewed?: boolean; installable?: boolean; trust?: string; kind?: string; requirements?: string[] };
export type Catalog = Availability & { profiles?: { id: string }[]; sources?: Source[] };
export type Listing = Availability & { actions?: string[]; note?: string; items?: Entry[]; content?: string; redacted?: boolean; columns?: string[]; tasks?: (Entry & { title: string; status: string; transitions?: string[] })[]; jobs?: (Entry & { schedule?: string; paused?: boolean })[] };
export const labels: Record<string, string> = { enable: "Aktivieren", disable: "Deaktivieren", install: "Installieren", pause: "Pausieren", resume: "Fortsetzen", edit: "Bearbeiten" };

export function unavailable(data: Availability): string | undefined {
  if (data.configured === false) return `Nicht eingerichtet: ${data.reason ?? "Host-Daemon nicht konfiguriert."}`;
  if (data.supported === false || data.available === false) return `Nicht unterstützt: ${data.reason ?? "Diese Funktion ist nicht verfügbar."}`;
}
