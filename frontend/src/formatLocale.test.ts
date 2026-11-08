import { afterEach, describe, expect, it } from "vitest";
import { dec, fmtAgo, fmtCount, fmtDate, loc } from "./format";
import { setLanguage } from "./i18n";
import { fmtUsd } from "./stats";

// Datum, Zahl und Dezimalzeichen folgen der gewählten Oberflächensprache, nicht fest Deutsch.
afterEach(async () => { await setLanguage("de"); });

describe("Formate je Sprache", () => {
  const day = new Date(2026, 10, 8, 12, 0).getTime();   // Sonntag, 8. November 2026
  const noCatalog = async () => ({} as Record<string, string>);

  it("Deutsch: Komma als Dezimalzeichen, Punkt als Tausendertrenner, Wochentag deutsch", async () => {
    await setLanguage("de");
    expect(loc()).toBe("de");
    expect(dec(1.5)).toBe("1,5");
    expect(fmtCount(1234567)).toBe("1.234.567");
    expect(fmtDate(day)).toMatch(/^So 08\.11\.$/);
  });

  it("Englisch: Punkt als Dezimalzeichen, Komma als Tausendertrenner, Wochentag englisch", async () => {
    await setLanguage("en", noCatalog);
    expect(loc()).toBe("en-GB");
    expect(dec(1.5)).toBe("1.5");
    expect(fmtCount(1234567)).toBe("1,234,567");
    expect(fmtDate(day)).toMatch(/^Sun 08\/11$/);
    expect(fmtUsd(1234.5)).toBe("1,234.50 $");
  });

  it("Relative Zeit nutzt den übersetzten Text", async () => {
    await setLanguage("en", async () => ({ "vor {n} Min": "{n} min ago" }));
    expect(fmtAgo(Date.now() - 5 * 60_000)).toBe("5 min ago");
  });
});
