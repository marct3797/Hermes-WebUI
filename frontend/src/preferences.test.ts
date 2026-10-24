import { beforeEach, describe, expect, it } from "vitest";
import { getPreferences, savePreferences } from "./preferences";

beforeEach(() => localStorage.clear());
describe("Geräteeinstellungen", () => {
  it("validiert gespeicherte Werte und merkt Host-Vorgaben getrennt", () => {
    localStorage.setItem("hermes.preferences", JSON.stringify({ enterSends: "false", compact: true, timeFormat: "no", hosts: { a: { effort: "invalid", workspace: 5 } } }));
    expect(getPreferences()).toMatchObject({ enterSends: true, compact: true, timeFormat: "24h", hosts: { a: { effort: "agent", workspace: "" } } });
    savePreferences({ enterSends: false, hosts: { a: { effort: "high", workspace: "project" } } });
    expect(getPreferences()).toMatchObject({ enterSends: false, hosts: { a: { effort: "high", workspace: "project" } } });
    localStorage.setItem("hermes.preferences", "null");
    expect(getPreferences().enterSends).toBe(true);
  });
});
