import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LANGUAGES, availableLanguages, detectLanguage, getLanguage, setLanguage, t, tm } from "./i18n";

const fake = (table: Record<string, string>) => async () => table;
beforeEach(() => { localStorage.clear(); });
afterEach(async () => { await setLanguage("de"); localStorage.clear(); });

describe("t", () => {
  it("returns the German source text when there is no translation", () => {
    expect(t("Speichern")).toBe("Speichern");
  });

  it("fills named placeholders and leaves unknown ones visible", () => {
    expect(t("{n} Aufgaben in {board}", { n: 3, board: "Alpha" })).toBe("3 Aufgaben in Alpha");
    expect(t("Hallo {name}")).toBe("Hallo {name}");
  });

  it("uses the catalog of the chosen language and falls back to German for a missing key", async () => {
    await setLanguage("en", fake({ Speichern: "Save", "{n} Aufgaben": "{n} tasks" }));
    expect(t("Speichern")).toBe("Save");
    expect(t("{n} Aufgaben", { n: 2 })).toBe("2 tasks");
    expect(t("Löschen")).toBe("Löschen");
  });

  it("does not run placeholders of the values themselves through the template again", async () => {
    await setLanguage("en", fake({ "Fehler: {text}": "Error: {text}" }));
    expect(t("Fehler: {text}", { text: "{text} $& {n}" })).toBe("Error: {text} $& {n}");
  });
});

describe("language choice", () => {
  it("remembers the choice, sets lang and writing direction on the page", async () => {
    await setLanguage("ar", fake({}));
    expect(getLanguage()).toBe("ar");
    expect(localStorage.getItem("hermes.lang")).toBe("ar");
    expect(document.documentElement.lang).toBe("ar");
    expect(document.documentElement.dir).toBe("rtl");
    await setLanguage("de");
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("rejects an unknown language instead of storing it", async () => {
    await expect(setLanguage("xx" as never, fake({}))).rejects.toThrow(/unbekannt|unknown/i);
    expect(localStorage.getItem("hermes.lang")).toBeNull();
  });

  it("keeps the old language when the catalog cannot be loaded", async () => {
    await expect(setLanguage("fr", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(getLanguage()).toBe("de");
    expect(localStorage.getItem("hermes.lang")).toBeNull();
  });

  it("maps browser languages, including regions and scripts, to the offered ones", () => {
    const has = (l: string) => ["de", "en", "pt", "zh", "zh-hant"].includes(l);
    expect(detectLanguage(["pt-BR"], has)).toBe("pt");
    expect(detectLanguage(["zh-TW"], has)).toBe("zh-hant");
    expect(detectLanguage(["zh-Hant-HK"], has)).toBe("zh-hant");
    expect(detectLanguage(["zh-CN"], has)).toBe("zh");
    expect(detectLanguage(["ru-RU", "de-AT"], has)).toBe("de");   // die erste angebotene Sprache der Liste
    expect(detectLanguage(["ru-RU"], has)).toBe("en");            // nichts passt: Englisch, wenn angeboten
    expect(detectLanguage(["ru-RU"], (l) => l === "de")).toBe("de"); // sonst die Quellsprache
  });

  it("a stored choice wins over the browser", async () => {
    localStorage.setItem("hermes.lang", "ja");
    expect(detectLanguage(["de-DE"], () => true)).toBe("ja");
    localStorage.setItem("hermes.lang", "kaputt");
    expect(detectLanguage(["de-DE"], () => true)).toBe("de");
  });
});

describe("offered languages", () => {
  it("lists German always and only languages that have a catalog file", () => {
    const ids = availableLanguages().map((l) => l.id);
    expect(ids[0]).toBe("de");
    expect(ids.every((id) => LANGUAGES.some((l) => l.id === id))).toBe(true);
  });

  it("knows Arabic as right-to-left and names every language in its own script", () => {
    expect(LANGUAGES.find((l) => l.id === "ar")?.rtl).toBe(true);
    expect(LANGUAGES.filter((l) => l.rtl).map((l) => l.id)).toEqual(["ar"]);
    expect(LANGUAGES.find((l) => l.id === "ja")?.endonym).toBe("日本語");
    expect(new Set(LANGUAGES.map((l) => l.id)).size).toBe(LANGUAGES.length);
  });
});

describe("tm (Meldungen des BFF)", () => {
  const cat = fake({
    "Skill nicht gefunden": "Skill not found",
    "Das Dashboard meldet Fehler {status_code}{why}": "The dashboard reports error {status_code}{why}",
    "Diese Hermes-Version kennt {path} nicht. Hermes aktualisieren": "This Hermes version does not know {path}. Update Hermes",
    "{what} antwortete mit Fehler {status}": "{what} answered with error {status}",
  });

  it("returns the German message unchanged in German", () => {
    expect(tm("Skill nicht gefunden")).toBe("Skill nicht gefunden");
  });

  it("translates an exact message and a message with filled-in values", async () => {
    await setLanguage("en", cat);
    expect(tm("Skill nicht gefunden")).toBe("Skill not found");
    expect(tm("Das Dashboard meldet Fehler 502: kaputt")).toBe("The dashboard reports error 502: kaputt");
  });

  it("keeps the values from the message, in the order of the translation", async () => {
    await setLanguage("en", cat);
    expect(tm("Diese Hermes-Version kennt /api/x/y nicht. Hermes aktualisieren")).toBe("This Hermes version does not know /api/x/y. Update Hermes");
  });

  it("prefers the more specific pattern over a generic one with a leading placeholder", async () => {
    await setLanguage("en", cat);
    expect(tm("Diese Hermes-Version kennt /a nicht. Hermes aktualisieren")).toContain("This Hermes version");
    expect(tm("Chroma antwortete mit Fehler 500")).toBe("Chroma answered with error 500");
  });

  it("leaves a message nobody translated as it is, and does not treat regex characters in a message as a pattern", async () => {
    await setLanguage("en", cat);
    expect(tm("Ganz neue Meldung (x+)")).toBe("Ganz neue Meldung (x+)");
    expect(tm("Skill nicht gefunden.*")).toBe("Skill nicht gefunden.*");
  });
});
