import { describe, expect, it } from "vitest";
import { checkLocale, collectKeys } from "../scripts/i18n-keys.mjs";
import { LANGUAGES, availableLanguages } from "./i18n";

const files = import.meta.glob<Record<string, string> | string[]>("./locales/*.json", { eager: true, import: "default" });
const catalogs = Object.fromEntries(Object.entries(files).map(([p, v]) => [p.replace("./locales/", "").replace(".json", ""), v]));
const present = Object.keys(catalogs).filter((id) => /^[a-z]{2}(-[a-z]+)?$/.test(id));
const keys = collectKeys();

describe("Sprachdateien", () => {
  it("die gespeicherte Schlüsselliste entspricht dem Code (node scripts/i18n-keys.mjs, wenn rot)", () => {
    expect(catalogs["_keys"]).toEqual(keys);
  });

  it("jede Sprachdatei gehört zu einer bekannten Sprache und wird angeboten", () => {
    expect(present.filter((id) => !LANGUAGES.some((l) => l.id === id))).toEqual([]);
    expect(availableLanguages().map((l) => l.id).sort()).toEqual(["de", ...present].sort());
  });

  it.each(present)("%s: vollständig, ohne Fremdschlüssel, mit denselben Platzhaltern und ohne leere Texte", (id) => {
    const r = checkLocale(id, keys);
    expect({ missing: r.missing.slice(0, 5), extra: r.extra.slice(0, 5), badPlaceholders: r.badPlaceholders.slice(0, 5), empty: r.empty.slice(0, 5) })
      .toEqual({ missing: [], extra: [], badPlaceholders: [], empty: [] });
  });

  it.each(present)("%s: enthält keine Gedankenstriche, wo das Original keine hat", (id) => {
    const cat = catalogs[id] as Record<string, string>;
    expect(Object.entries(cat).filter(([de, tr]) => /[\u2014\u2013]/.test(tr) && !/[\u2014\u2013]/.test(de)).map(([de]) => de).slice(0, 5)).toEqual([]);
  });

  it.each(present)("%s: ist wirklich übersetzt und nicht nur kopiert", (id) => {
    const r = checkLocale(id, keys);
    expect(r.same.length / keys.length).toBeLessThan(0.35);
  });
});
