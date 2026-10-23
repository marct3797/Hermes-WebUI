/** Zeilenvergleich für die Änderungsvorschau (SOUL.md): kleinste gemeinsame Teilfolge, dann Kontext um die Änderungen. */
export type DiffLine = { kind: "same" | "add" | "del"; text: string };
export type DiffItem = DiffLine | { kind: "skip"; count: number };

/** Obergrenze der Zeilen, die nach dem Abschneiden von Anfang und Ende noch verglichen werden (Speicher wächst quadratisch). */
export const MAX_DIFF_LINES = 1500;

/** `null`, wenn die Texte zu verschieden und zu lang für einen Vergleich im Browser sind. */
export function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length > MAX_DIFF_LINES || midB.length > MAX_DIFF_LINES) return null;

  // lcs[i][j] = Länge der gemeinsamen Teilfolge von midA[i..] und midB[j..]
  const w = midB.length + 1;
  const lcs = new Uint32Array((midA.length + 1) * w);
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      lcs[i * w + j] = midA[i] === midB[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const out: DiffLine[] = a.slice(0, start).map((text) => ({ kind: "same", text }));
  let i = 0;
  let j = 0;
  while (i < midA.length || j < midB.length) {
    if (i < midA.length && j < midB.length && midA[i] === midB[j]) { out.push({ kind: "same", text: midA[i] }); i++; j++; }
    else if (i < midA.length && (j === midB.length || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) out.push({ kind: "del", text: midA[i++] });
    else out.push({ kind: "add", text: midB[j++] });
  }
  for (const text of a.slice(endA)) out.push({ kind: "same", text });
  return out;
}

export const diffStats = (lines: DiffLine[]) => ({
  added: lines.filter((l) => l.kind === "add").length,
  removed: lines.filter((l) => l.kind === "del").length,
});

/** Unveränderte Zeilen weiter als `context` von einer Änderung werden zu einem "skip"-Eintrag zusammengefasst. */
export function withContext(lines: DiffLine[], context = 2): DiffItem[] {
  const near = new Set<number>();
  lines.forEach((l, i) => {
    if (l.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) near.add(k);
  });
  const out: DiffItem[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (near.has(i)) {
      if (skipped) { out.push({ kind: "skip", count: skipped }); skipped = 0; }
      out.push(l);
    } else skipped++;
  });
  if (skipped) out.push({ kind: "skip", count: skipped });
  return out;
}
