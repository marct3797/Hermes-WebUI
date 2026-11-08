// Sammelt alle Übersetzungsschlüssel (deutsche Texte) aus t("..."), tr("...") und N_("...") und prüft Sprachdateien.
//   node scripts/i18n-keys.mjs            schreibt src/locales/_keys.json
//   node scripts/i18n-keys.mjs --check de|en|...   prüft src/locales/<id>.json gegen die Liste
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(import.meta.dirname, "../src");
export const LOCALES = path.join(SRC, "locales");
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== "locales" && e.name !== "fixtures") walk(p); } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && e.name !== "test-backend.ts") files.push(p); } })(SRC);

export function collectKeys() {
  const keys = new Set();
  for (const f of files) {
    const sf = ts.createSourceFile(f, fs.readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const v = (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^(t|tr|N_)$/.test(n.expression.text) && n.arguments.length && ts.isStringLiteralLike(n.arguments[0])) keys.add(n.arguments[0].text);
      ts.forEachChild(n, v);
    };
    v(sf);
  }
  const backend = path.join(LOCALES, "_backend.json");   // Texte des BFF (siehe scripts/i18n-backend.py)
  if (fs.existsSync(backend)) for (const k of JSON.parse(fs.readFileSync(backend, "utf8"))) keys.add(k);
  return [...keys].sort((a, b) => a.localeCompare(b, "de"));
}
export const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

export function checkLocale(id, keys = collectKeys()) {
  const file = path.join(LOCALES, `${id}.json`);
  if (!fs.existsSync(file)) return { missing: keys, extra: [], badPlaceholders: [], empty: [], same: [] };
  const cat = JSON.parse(fs.readFileSync(file, "utf8")); const set = new Set(keys);
  return {
    missing: keys.filter((k) => !(k in cat)),
    extra: Object.keys(cat).filter((k) => !set.has(k)),
    badPlaceholders: keys.filter((k) => k in cat && placeholders(cat[k]) !== placeholders(k)),
    empty: keys.filter((k) => k in cat && !String(cat[k]).trim()),
    same: keys.filter((k) => k in cat && cat[k] === k && /[a-zäöüß]{4,}/i.test(k)),
  };
}

if (process.argv[1] === import.meta.filename) {
  const arg = process.argv.indexOf("--check");
  if (arg > 0) {
    const r = checkLocale(process.argv[arg + 1]);
    for (const [k, v] of Object.entries(r)) console.log(`${k}: ${v.length}`, v.slice(0, 5).map((x) => JSON.stringify(x)).join(" | "));
    process.exit(r.missing.length || r.extra.length || r.badPlaceholders.length || r.empty.length ? 1 : 0);
  }
  fs.mkdirSync(LOCALES, { recursive: true });
  const keys = collectKeys(); fs.writeFileSync(path.join(LOCALES, "_keys.json"), JSON.stringify(keys, null, 1) + "\n");
  console.log(keys.length, "Schlüssel,", keys.filter((k) => k.includes("{")).length, "mit Platzhaltern,", keys.reduce((a, k) => a + k.length, 0), "Zeichen");
}
