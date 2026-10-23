import { describe, expect, it } from "vitest";
import { MAX_DIFF_LINES, diffStats, lineDiff, withContext } from "./diff";

const kinds = (d: ReturnType<typeof lineDiff>) => d?.map((l) => `${l.kind[0]}:${l.text}`);

describe("lineDiff", () => {
  it("marks added, removed and unchanged lines in order", () => {
    expect(kinds(lineDiff("a\nb\nc", "a\nB\nc\nd"))).toEqual(["s:a", "d:b", "a:B", "s:c", "a:d"]);
  });

  it("returns only unchanged lines for equal texts", () => {
    const d = lineDiff("eins\nzwei", "eins\nzwei")!;
    expect(d.every((l) => l.kind === "same")).toBe(true);
    expect(diffStats(d)).toEqual({ added: 0, removed: 0 });
  });

  it("treats an empty before-text as all added", () => {
    expect(diffStats(lineDiff("", "x\ny")!)).toEqual({ added: 2, removed: 1 }); // "" ist eine leere Zeile, die ersetzt wird
  });

  it("finds a moved block as removal plus addition", () => {
    const d = lineDiff("a\nb\nc\nd", "a\nc\nd\nb")!;
    expect(diffStats(d)).toEqual({ added: 1, removed: 1 });
  });

  it("gives up on very long differing middles instead of freezing the tab", () => {
    const big = (p: string) => Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `${p}${i}`).join("\n");
    expect(lineDiff(big("a"), big("b"))).toBeNull();
    expect(lineDiff(`${big("a")}\nx`, `${big("a")}\ny`)).not.toBeNull(); // gemeinsamer Anfang zählt nicht mit
  });
});

describe("withContext", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `z${i}`).join("\n");

  it("folds long unchanged runs and keeps the lines around a change", () => {
    const d = lineDiff(lines(20), lines(20).replace("z10", "NEU"))!;
    const items = withContext(d, 2);
    expect(items[0]).toEqual({ kind: "skip", count: 8 });
    expect(items.slice(1).map((i) => (i.kind === "skip" ? `skip${i.count}` : `${i.kind[0]}:${i.text}`))).toEqual(
      ["s:z8", "s:z9", "d:z10", "a:NEU", "s:z11", "s:z12", "skip7"]);
  });

  it("keeps everything when changes are close together", () => {
    expect(withContext(lineDiff("a\nb\nc", "a\nx\nc")!, 2).some((i) => i.kind === "skip")).toBe(false);
  });
});
