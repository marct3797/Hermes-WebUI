// Findet JSX-Elemente, in denen Text mit {Ausdruck} oder Kind-Elementen gemischt ist. node scripts/i18n-mixed.mjs [src-Ordner] [--list]
import ts from "typescript"; import fs from "node:fs"; import path from "node:path";
const SRC = path.resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : path.join(import.meta.dirname, "../src"));
const files = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== "fixtures") walk(p); } else if (/\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name)) files.push(p); } })(SRC);
let n = 0, withExpr = 0, withEl = 0; const list = [];
for (const f of files) {
  const sf = ts.createSourceFile(f, fs.readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const v = (node) => {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const kids = node.children; const text = kids.filter((k) => ts.isJsxText(k) && /[A-Za-zÄÖÜäöüß]{2,}/.test(k.getText()));
      const ex = kids.filter((k) => ts.isJsxExpression(k) && k.expression && !/^(t|tr)\(/.test(k.expression.getText()));
      const el = kids.filter((k) => ts.isJsxElement(k) || ts.isJsxSelfClosingElement(k));
      if (text.length && (ex.length || el.length)) { n++; if (ex.length) withExpr++; if (el.length) withEl++; list.push(`${path.relative(SRC, f)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${ex.length ? "expr" : ""}${el.length ? " elem" : ""} | ${node.getText().replace(/\s+/g, " ").slice(0, 110)}`); }
    }
    ts.forEachChild(node, v);
  };
  v(sf);
}
console.log("gemischt:", n, "davon mit {Ausdruck}:", withExpr, "mit Kind-Element:", withEl);
if (process.argv.includes("--list")) console.log(list.join("\n"));
