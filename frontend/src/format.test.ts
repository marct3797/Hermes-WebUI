import { describe, expect, it } from "vitest";
import { dayGroup, fmtClock, fmtDuration, plainPreview, toMs, toolIcon } from "./format";

describe("format", () => {
  it("formats durations and clocks the German way", () => {
    expect(fmtDuration(40)).toBe("0,04 s");
    expect(fmtDuration(3200)).toBe("3,2 s");
    expect(fmtDuration(65_000)).toBe("1:05 min");
    expect(fmtClock(299.4)).toBe("4:59");
    expect(fmtClock(-3)).toBe("0:00");
  });

  it("reads epoch seconds, milliseconds and ISO text; anything else is unknown", () => {
    expect(toMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(toMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(toMs("2026-10-22T10:00:00Z")).toBe(Date.parse("2026-10-22T10:00:00Z"));
    expect(toMs("gestern")).toBeUndefined();
    expect(toMs(undefined)).toBeUndefined();
  });

  it("groups by calendar day", () => {
    const now = new Date(2026, 9, 22, 15, 0).getTime();
    expect(dayGroup(new Date(2026, 9, 22, 0, 5).getTime(), now)).toBe("today");
    expect(dayGroup(new Date(2026, 9, 21, 23, 59).getTime(), now)).toBe("yesterday");
    expect(dayGroup(new Date(2026, 9, 20, 12, 0).getTime(), now)).toBe("older");
    expect(dayGroup(undefined, now)).toBe("older");
  });

  it("picks a tool icon from the name and falls back to the wrench", () => {
    expect(toolIcon("terminal")).toBe("terminal");
    expect(toolIcon("web_search")).toBe("globe");
    expect(toolIcon("delegate_task")).toBe("cpu");
    expect(toolIcon("mystery")).toBe("wrench");
  });
});

describe("plainPreview", () => {
  it("drops markdown marks, folds code blocks and collapses whitespace", () => {
    expect(plainPreview("# Titel\n\nHallo **Welt** mit `x`\n\n```py\nprint(1)\n```\n- eins")).toBe("Titel Hallo Welt mit x [Code] - eins");
  });
});
