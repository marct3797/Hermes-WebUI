import type { AgentRef } from "./types";

/**
 * Entwurf über die erneute Anmeldung hinweg: Speichern verlangt eine frische Anmeldung (Step-up), die Seite lädt dabei neu.
 * Der Entwurf liegt nur in dieser Browser-Sitzung (sessionStorage) und wird beim Laden einmal zurückgegeben.
 */
const key = (a: AgentRef) => `soul-draft:${a.host}/${a.runtime}/${a.agent}`;

export type Draft = { content: string; base: string };

export function stashDraft(a: AgentRef, draft: Draft) {
  try { sessionStorage.setItem(key(a), JSON.stringify(draft)); } catch { /* ohne Speicher geht der Entwurf bei der Anmeldung verloren */ }
}

export function peekDraft(a: AgentRef): Draft | null {
  try {
    const raw = JSON.parse(sessionStorage.getItem(key(a)) ?? "null") as Partial<Draft> | null;
    return raw && typeof raw.content === "string" && typeof raw.base === "string" ? { content: raw.content, base: raw.base } : null;
  } catch { return null; }
}

export function dropDraft(a: AgentRef) {
  try { sessionStorage.removeItem(key(a)); } catch { /* nichts zu tun */ }
}
