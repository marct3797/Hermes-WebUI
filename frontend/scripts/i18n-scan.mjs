// Zählt die Texte, die übersetzt werden müssen. Nur lesend:  node scripts/i18n-scan.mjs [--list]
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(import.meta.dirname, "../src");
const ATTRS = new Set(["aria-label", "placeholder", "title", "alt", "label", "description", "hint", "sub", "summary", "aria-description"]);
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== "fixtures") walk(p); }
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && e.name !== "test-backend.ts") files.push(p);
  }
})(SRC);

const hasText = (s) => /[A-Za-zÄÖÜäöüß]{2,}/.test(s);
const germanish = (s) => /[äöüÄÖÜß]/.test(s) || /\b(der|die|das|und|oder|nicht|mit|für|keine?|wird|werden|ist|sind|noch|bitte|Fehler|Neu|Alle|Abbrechen|Speichern|Löschen|Laden|Suche)\b/i.test(s);
const found = { jsxText: new Map(), attr: new Map(), template: new Map(), literal: new Map() };
const add = (kind, text, file) => { const m = found[kind]; const k = text.replace(/\s+/g, " ").trim(); if (!m.has(k)) m.set(k, new Set()); m.get(k).add(path.relative(SRC, file)); };

for (const f of files) {
  const sf = ts.createSourceFile(f, fs.readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (n) => {
    if (ts.isJsxText(n)) { const t = n.getText().replace(/\s+/g, " ").trim(); if (hasText(t)) add("jsxText", t, f); }
    else if (ts.isJsxAttribute(n) && n.initializer && ts.isStringLiteral(n.initializer) && ATTRS.has(n.name.getText())) { if (hasText(n.initializer.text)) add("attr", n.initializer.text, f); }
    else if (ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n)) { const t = n.getText().slice(1, -1); if (hasText(t) && germanish(t)) add("template", t, f); }
    else if (ts.isStringLiteral(n) && !ts.isJsxAttribute(n.parent) && !ts.isImportDeclaration(n.parent) && !ts.isExportDeclaration(n.parent) && !ts.isLiteralTypeNode(n.parent)) {
      if (n.text.includes(" ") && germanish(n.text) && n.text.length > 3) add("literal", n.text, f);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
let total = 0;
for (const [k, m] of Object.entries(found)) { console.log(`${k}: ${m.size} verschiedene Texte`); total += m.size; }
console.log(`Summe verschiedene Texte: ${total}; Dateien mit Texten: ${new Set([...Object.values(found)].flatMap((m) => [...m.values()].flatMap((s) => [...s]))).size} von ${files.length}`);
if (process.argv.includes("--list")) for (const [k, m] of Object.entries(found)) for (const [t, fs_] of m) console.log(`${k}\t${t}\t${[...fs_][0]}`);
