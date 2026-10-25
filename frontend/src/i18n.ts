import { useSyncExternalStore } from "react";

/** Mehrsprachigkeit ohne Fremdpaket. Der deutsche Originaltext ist der Schlüssel: `t("Speichern")`, mit Platzhaltern `t("{n} Aufgaben", { n })`.
 * Fehlt eine Übersetzung, erscheint der deutsche Text. Katalog je Sprache: `src/locales/<id>.json` (Schlüssel = deutscher Text). */

export type LanguageId = "de" | "en" | "es" | "fr" | "pt" | "zh" | "zh-hant" | "ja" | "ko" | "ar" | "it" | "tr";
export type Language = { id: LanguageId; endonym: string; rtl?: boolean };
// Namen in der eigenen Schrift und Schreibrichtung wie in Hermes (agent/i18n_languages.py); jede Sprache braucht zusätzlich eine Katalogdatei, um angeboten zu werden.
export const LANGUAGES: readonly Language[] = [
  { id: "de", endonym: "Deutsch" }, { id: "en", endonym: "English" }, { id: "es", endonym: "Español" }, { id: "fr", endonym: "Français" },
  { id: "pt", endonym: "Português" }, { id: "zh", endonym: "简体中文" }, { id: "zh-hant", endonym: "繁體中文" }, { id: "ja", endonym: "日本語" },
  { id: "ko", endonym: "한국어" }, { id: "ar", endonym: "العربية", rtl: true }, { id: "it", endonym: "Italiano" }, { id: "tr", endonym: "Türkçe" },
];
const SOURCE: LanguageId = "de";
const KEY = "hermes.lang";
type Catalog = Record<string, string>;
type Loader = (id: LanguageId) => Promise<Catalog>;

const files = import.meta.glob<{ default: Catalog }>("./locales/*.json");
const fileFor = (id: string) => `./locales/${id}.json`;
const hasCatalog = (id: string) => id === SOURCE || fileFor(id) in files;
const defaultLoader: Loader = async (id) => {
  const load = files[fileFor(id)];
  if (!load) throw new Error(`Keine Übersetzung für ${id}`);
  return (await load()).default;
};

let current: LanguageId = SOURCE;
let table: Catalog = {};
const listeners = new Set<() => void>();

export function t(de: string, vars?: Record<string, string | number>): string {
  const s = table[de] ?? de;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s; // ein Durchlauf: Werte werden nicht erneut als Vorlage gelesen
}

export const getLanguage = () => current;
export const availableLanguages = (): Language[] => LANGUAGES.filter((l) => hasCatalog(l.id));

/** Wechselt erst, wenn der Katalog geladen ist; bei einem Fehler bleibt die bisherige Sprache. */
export async function setLanguage(id: LanguageId, loader: Loader = defaultLoader): Promise<void> {
  const lang = LANGUAGES.find((l) => l.id === id);
  if (!lang) throw new Error(`Unbekannte Sprache: ${String(id)}`);
  const next = id === SOURCE ? {} : await loader(id);
  current = id; table = next;
  try { localStorage.setItem(KEY, id); } catch { /* ohne Speicher gilt die Wahl nur für diese Sitzung */ }
  document.documentElement.lang = id;
  document.documentElement.dir = lang.rtl ? "rtl" : "ltr";
  listeners.forEach((fn) => fn());
}

function fromTag(tag: string): string {
  const lower = tag.toLowerCase();
  if (lower.startsWith("zh")) return /hant|[-_](tw|hk|mo)\b/.test(lower) ? "zh-hant" : "zh";
  return lower.split(/[-_]/)[0];
}

/** Gespeicherte Wahl, sonst die erste Browsersprache, die angeboten wird; passt nichts, Englisch, sonst die Quellsprache. */
export function detectLanguage(browser: readonly string[] = navigator.languages ?? [navigator.language], has: (id: string) => boolean = hasCatalog): LanguageId {
  let stored: string | null = null;
  try { stored = localStorage.getItem(KEY); } catch { /* ohne Speicher */ }
  if (stored && LANGUAGES.some((l) => l.id === stored) && has(stored)) return stored as LanguageId;
  for (const tag of browser) { const c = fromTag(tag); if (has(c) && LANGUAGES.some((l) => l.id === c)) return c as LanguageId; }
  return has("en") ? "en" : SOURCE;
}

/** Beim Start vor dem ersten Zeichnen; ein nicht ladbarer Katalog lässt die Oberfläche deutsch. */
export async function initLanguage(): Promise<void> {
  const id = detectLanguage();
  if (id !== SOURCE) await setLanguage(id).catch(() => undefined);
}

const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const useLanguage = (): LanguageId => useSyncExternalStore(subscribe, getLanguage);
