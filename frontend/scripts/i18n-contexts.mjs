import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
const SRC = path.resolve(import.meta.dirname, "../src");
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && e.name !== "test-backend.ts") files.push(p); } })(SRC);
const germanish = (s) => /[äöüÄÖÜß]/.test(s) || /\b(der|die|das|und|oder|nicht|mit|für|keine?|wird|werden|ist|sind|noch|bitte|Fehler|Neu|Alle|Abbrechen|Speichern|Löschen|Laden|Suche)\b/i.test(s);
const C = new Map(); const ex = new Map();
const fn = (n) => { for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return true; return false; };
for (const f of files) {
  const sf = ts.createSourceFile(f, fs.readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (n) => {
    const lit = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n);
    if (lit && !ts.isJsxAttribute(n.parent) && !ts.isImportDeclaration(n.parent) && !ts.isLiteralTypeNode(n.parent)) {
      const text = ts.isTemplateExpression(n) ? n.getText().slice(1, -1) : n.text;
      if (text.includes(" ") && germanish(text) && text.length > 3) {
        const p = n.parent; let k = ts.SyntaxKind[p.kind];
        if (ts.isCallExpression(p)) k += ":" + p.expression.getText().replace(/\s+/g, "").slice(0, 28);
        else if (ts.isPropertyAssignment(p)) k += ":" + p.name.getText();
        else if (ts.isNewExpression(p)) k += ":" + p.expression.getText();
        k += fn(n) ? " [fn]" : " [modul]";
        C.set(k, (C.get(k) || 0) + 1); if (!ex.has(k)) ex.set(k, text.slice(0, 50));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
for (const [k, v] of [...C].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(4), k, "|", ex.get(k));
