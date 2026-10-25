// Fügt zerlegte Sätze zusammen: {t("Lauf")} {w.id}, {w.profile} -> {t("Lauf {id}, {profile}", { id: w.id, profile: w.profile })}
// Probelauf: node scripts/i18n-merge.mjs [--list]    schreiben: node scripts/i18n-merge.mjs --write
// Ein Lauf besteht aus direkt benachbarten Kindern: t(...)-Text, Text/Satzzeichen, Zeichenketten und Werte-Ausdrücke. Kind-Elemente (<b>, <Link>) und Ausdrücke mit JSX beenden den Lauf.
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(import.meta.dirname, "../src");
const WRITE = process.argv.includes("--write"), LIST = process.argv.includes("--list");
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== "fixtures") walk(p); } else if (/\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name)) files.push(p); } })(SRC);

const ENT = { amp: "&", nbsp: "\u00a0", quot: '"', apos: "'", lt: "<", gt: ">", middot: "·", hellip: "…" };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, g) => (g[0] === "#" ? String.fromCodePoint(g[1].toLowerCase() === "x" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10)) : ENT[g] ?? m));

// JSX-Regeln für Text: Zeilen trimmen, leere Zeilen weglassen, mit Leerzeichen verbinden.
function jsxText(raw) {
  const lines = raw.split(/\r\n|\n|\r/); let last = 0;
  lines.forEach((l, i) => { if (/[^ \t]/.test(l)) last = i; });
  let out = "";
  lines.forEach((line, i) => {
    let t = line.replace(/\t/g, " ");
    if (i !== 0) t = t.replace(/^[ ]+/, "");
    if (i !== lines.length - 1) t = t.replace(/[ ]+$/, "");
    if (t) { if (i !== last) t += " "; out += t; }
  });
  return decode(out);
}
const hasJsx = (n) => { let hit = false; const v = (x) => { if (ts.isJsxElement(x) || ts.isJsxSelfClosingElement(x) || ts.isJsxFragment(x)) hit = true; ts.forEachChild(x, v); }; v(n); return hit; };
const tText = (k) => ts.isJsxExpression(k) && k.expression && ts.isCallExpression(k.expression) && ts.isIdentifier(k.expression.expression) && /^(t|tr)$/.test(k.expression.expression.text) && k.expression.arguments.length === 1 && ts.isStringLiteral(k.expression.arguments[0]) ? k.expression.arguments[0].text : null;
function name(expr, used) {
  const bare = expr.getText().replace(/\b(t|tr)\((?:[^()]|\([^()]*\))*\)/g, "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, "");   // Zeichenketten und t()-Aufrufe zählen nicht für den Namen
  let base = ts.isIdentifier(expr) ? expr.text : ts.isPropertyAccessExpression(expr) ? expr.name.text : (bare.match(/([A-Za-z_]\w*)\W*$/) ?? [])[1] ?? "v";
  base = base.replace(/\d+$/, "") || "v"; if (!/^\w+$/.test(base) || /^(t|tr|de|n|s|length|join|map|filter|toFixed|round)$/.test(base)) base = "v";
  let nm = base, i = 2; while (used.has(nm)) nm = base + i++; used.add(nm); return nm;
}

let merged = 0, skipped = 0; const samples = [];
for (const f of files) {
  let text = fs.readFileSync(f, "utf8");
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const alias = /import \{[^}]*\bt as tr\b/.test(text) ? "tr" : "t";
  const edits = [];
  const visit = (node) => {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const kids = [...node.children]; let run = [];
      const flush = () => {
        const r = run; run = [];
        if (!r.some((k) => tText(k) !== null) || !r.some((k) => ts.isJsxExpression(k) && tText(k) === null && k.expression && !ts.isStringLiteral(k.expression))) return;
        const used = new Set(), vars = []; let key = "";
        for (const k of r) {
          if (ts.isJsxText(k)) key += jsxText(text.slice(k.pos, k.end));
          else if (tText(k) !== null) key += tText(k);
          else if (ts.isStringLiteral(k.expression)) key += k.expression.text;
          else { const nm = name(k.expression, used); key += `{${nm}}`; vars.push(ts.isIdentifier(k.expression) && k.expression.text === nm ? nm : `${nm}: ${k.expression.getText()}`); }
        }
        if (/^\s|\s$/.test(key) || /\{\w+\}/.test(r.filter((k) => tText(k) !== null).map(tText).join("")) || !/[A-Za-zÄÖÜäöüß]{2,}/.test(key.replace(/\{\w+\}/g, ""))) { skipped++; return; }
        edits.push({ start: r[0].getStart(), end: r[r.length - 1].getEnd(), text: `{${alias}(${JSON.stringify(key)}, { ${vars.join(", ")} })}` });
        samples.push(`${path.relative(SRC, f)}: ${key.slice(0, 90)}`);
      };
      for (const k of kids) {
        const ok = ts.isJsxText(k) || (ts.isJsxExpression(k) && (!k.expression || !hasJsx(k.expression)) && !(k.expression === undefined));
        if (ok) run.push(k); else flush();
      }
      flush();
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!edits.length) continue;
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) { text = text.slice(0, e.start) + e.text + text.slice(e.end); merged++; }
  if (WRITE) fs.writeFileSync(f, text);
}
console.log(WRITE ? "GESCHRIEBEN" : "PROBELAUF", "zusammengefügt:", merged, "ausgelassen:", skipped);
if (LIST) console.log(samples.join("\n"));
