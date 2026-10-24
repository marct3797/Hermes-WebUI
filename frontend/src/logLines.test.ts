import { describe, expect, it } from "vitest";
import { levels, mergeLines } from "./logLines";

describe("mergeLines", () => {
  it("appends only the new tail", () => expect(mergeLines(["a", "b", "c"], ["b", "c", "d", "e"])).toEqual(["a", "b", "c", "d", "e"]));
  it("changes nothing when nothing is new", () => expect(mergeLines(["a", "b"], ["a", "b"])).toEqual(["a", "b"]));
  it("appends everything when the window moved past the old lines", () => expect(mergeLines(["a", "b"], ["x", "y"])).toEqual(["a", "b", "x", "y"]));
  it("takes the first load as is and caps the total", () => {
    expect(mergeLines([], ["a"])).toEqual(["a"]);
    expect(mergeLines(["1", "2", "3"], ["3", "4"], 3)).toEqual(["2", "3", "4"]);
  });
  it("handles repeated identical lines by the longest overlap", () => expect(mergeLines(["x", "x"], ["x", "x", "x"])).toEqual(["x", "x", "x"]));
});

describe("levels", () => {
  it("lets continuation lines inherit the level", () => {
    expect(levels(["    ^", "2026-10-24 03:30:04,691 WARNING [x] a: b", "Traceback", "2026-10-24 03:31:00,000 ERROR [x] c: d", "  File"])).toEqual([null, "WARNING", "WARNING", "ERROR", "ERROR"]);
  });
});
