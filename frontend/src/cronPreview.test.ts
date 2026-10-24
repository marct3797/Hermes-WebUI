import { describe, expect, it } from "vitest";
import { describeInterval, nextRuns } from "./cronPreview";

const at = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const from = new Date(2026, 9, 24, 12, 0, 30);  // Samstag, 24.10.2026 12:00:30

describe("nextRuns", () => {
  it("finds the next daily runs", () => {
    expect(nextRuns("30 4 * * *", from)!.map(at)).toEqual(["2026-10-25 04:30", "2026-10-26 04:30", "2026-10-27 04:30"]);
  });
  it("handles steps, lists and ranges", () => {
    expect(nextRuns("*/20 12 * * *", from)!.map(at)).toEqual(["2026-10-24 12:20", "2026-10-24 12:40", "2026-10-25 12:00"]);
    expect(nextRuns("0 9,17 * * 1-5", from)!.map(at)).toEqual(["2026-10-26 09:00", "2026-10-26 17:00", "2026-10-27 09:00"]);
  });
  it("uses day-of-month OR day-of-week when both are restricted, like cron", () => {
    expect(nextRuns("0 0 1 * 1", from, 2)!.map(at)).toEqual(["2026-10-26 00:00", "2026-11-01 00:00"]);
  });
  it("accepts 7 as Sunday", () => {
    expect(nextRuns("0 8 * * 7", from, 1)!.map(at)).toEqual(["2026-10-25 08:00"]);
  });
  it("returns null for anything it does not understand", () => {
    for (const bad of ["", "every 30m", "* * * *", "61 * * * *", "* * * * MON", "5-1 * * * *", "*/0 * * * *", "0 0 31 2 *"]) expect(nextRuns(bad, from), bad).toBeNull();
  });
});

describe("describeInterval", () => {
  it("describes interval forms", () => {
    expect(describeInterval("30m")).toBe("alle 30 Minuten");
    expect(describeInterval("every 1h")).toBe("jede Stunde");
    expect(describeInterval("every 2d")).toBe("alle 2 Tage");
    expect(describeInterval("0 9 * * *")).toBeNull();
  });
});
