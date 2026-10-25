// Umhüllt deutsche Anzeigetexte mit t(...). Probelauf ohne Schreiben:  node scripts/i18n-wrap.mjs   |   schreiben: node scripts/i18n-wrap.mjs --write
// Bewusst NICHT angefasst (wird gemeldet): Texte auf Modulebene (würden beim Import fest übersetzt), Vergleiche, Schlüssel, Aufrufe wie includes/get/setItem.
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(import.meta.dirname, "../src");
const WRITE = process.argv.includes("--write");
const RESIDUAL = process.argv.includes("--residual");
const LAX = process.argv.includes("--lax");   // zweiter Durchlauf: auch Einzelwörter und Kleinschreibung an Anzeigestellen
const laxLog = new Map();
const GERMAN_CAPS = new Set(["FEHLER", "FERTIG", "SCHLÄFT", "FREIGABE", "GETRENNT", "OFFLINE"]);
const GERMAN_LOWER = new Set(["streamt", "alle", "aktiv", "deaktiviert", "bestanden", "gestartet", "gestoppt", "gesetzt", "abgelaufen", "lokal", "keine", "unbekannt", "wartet", "gespeichert", "verbunden"]);
const NONDISPLAY_CALL = /^(navigate|dispatch|addEventListener|removeEventListener|setAttribute|getAttribute|fetch|api|request|post|put|del|patch|chip|useRef|createContext|Number|String|Boolean|parseInt)$/;
function laxOk(n, p) {
  const v = n.text, trimmed = v.trim();
  if (!hasText(v) || v.length < 3) return false;
  if (/[/:._@#=<>{}\\]/.test(trimmed) || /^\d/.test(trimmed)) return false;      // Pfade, Adressen, CSS-Werte
  if (/^[A-Z0-9 _-]+$/.test(trimmed)) return GERMAN_CAPS.has(trimmed);              // Methoden und Kürzel
  const spaced = /\s/.test(trimmed), umlaut = /[äöüÄÖÜß]/.test(v);
  const lowerToken = /^[a-zäöüß][a-zA-Z0-9äöüß]*([-_][a-z0-9]+)*$/.test(trimmed);
  if (lowerToken && !GERMAN_LOWER.has(trimmed)) return false;                       // IDs, Zustände, Ereignisnamen
  if (ts.isPropertyAssignment(p)) return DISPLAY_PROPS.has(p.name.getText()) || ["prompt", "group", "error"].includes(p.name.getText());
  if (ts.isCallExpression(p) && NONDISPLAY_CALL.test(p.expression.getText().replace(/\s+/g, ""))) return false;
  if (ts.isVariableDeclaration(p) || ts.isBindingElement(p)) return spaced || umlaut || capWord(v);
  return spaced || umlaut || capWord(v) || GERMAN_LOWER.has(trimmed);
}
const ATTRS = new Set(["aria-label", "placeholder", "title", "alt", "label", "description", "hint", "sub", "summary", "aria-description", "emptyText", "heading", "tooltip", "confirmLabel", "message"]);
const SKIP_CALLEE = /(^|\.)(includes|startsWith|endsWith|test|has|get|set|getItem|setItem|removeItem|querySelector|querySelectorAll|replace|replaceAll|split|join|match|indexOf|add|delete|log|warn|info|debug|error)$/;
const DISPLAY_PROPS = new Set(["label", "title", "text", "message", "error", "description", "detail", "hint", "placeholder", "heading", "summary", "empty", "note", "body", "name", "sub"]);
const ENT = { amp: "&", nbsp: "\u00a0", quot: '"', apos: "'", lt: "<", gt: ">", middot: "·", hellip: "…" };

const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === "fixtures") continue; else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !["test-backend.ts", "i18n.ts", "test-setup.ts"].includes(e.name)) files.push(p); } })(SRC);

const COMPARED = new Set();   // Zeichenketten, die irgendwo verglichen oder als Schlüssel benutzt werden: nie übersetzen
for (const f of files) {
  const sf = ts.createSourceFile(f, fs.readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const v = (n) => {
    if (ts.isBinaryExpression(n) && /^(===|!==|==|!=)$/.test(n.operatorToken.getText())) for (const o of [n.left, n.right]) if (ts.isStringLiteralLike(o)) COMPARED.add(o.text);
    if (ts.isCaseClause(n) && ts.isStringLiteralLike(n.expression)) COMPARED.add(n.expression.text);
    if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) COMPARED.add(n.argumentExpression.text);
    if (ts.isCallExpression(n) && /\.(includes|has|get|indexOf)$/.test(n.expression.getText())) for (const a of n.arguments) if (ts.isStringLiteralLike(a)) COMPARED.add(a.text);
    ts.forEachChild(n, v);
  };
  v(sf);
}
const hasText = (s) => /[A-Za-zÄÖÜäöüß]{2,}/.test(s);
const germanish = (s) => /[äöüÄÖÜß]/.test(s) || /\b(der|die|das|und|oder|nicht|mit|für|keine?|wird|werden|ist|sind|noch|bitte|Fehler|Neu|Alle|Abbrechen|Speichern|Löschen|Laden|Suche)\b/i.test(s);
const capWord = (s) => /^[A-ZÄÖÜ][a-zäöüß]{2,}(…|\.\.\.)?$/.test(s);
const inFn = (n) => { for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return true; return false; };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, g) => (g[0] === "#" ? String.fromCodePoint(g[1].toLowerCase() === "x" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10)) : ENT[g] ?? m));
const stats = { jsxText: 0, attr: 0, literal: 0, template: 0, getter: 0 };
const skipped = { modul: [], entity: [], brace: [], unknown: [], verglichen: [] };

function declaresT(sf) {
  let hit = false;
  const v = (n) => {
    if ((ts.isParameter(n) || ts.isVariableDeclaration(n) || ts.isBindingElement(n) || ts.isFunctionDeclaration(n)) && n.name && ts.isIdentifier(n.name) && n.name.text === "t") hit = true;
    ts.forEachChild(n, v);
  };
  v(sf); return hit;
}

function placeholderName(expr, used) {
  let base = ts.isIdentifier(expr) ? expr.text : ts.isPropertyAccessExpression(expr) ? expr.name.text : (expr.getText().match(/([A-Za-z_]\w*)\W*$/) ?? [])[1] ?? "v";   // sprechender Name aus dem letzten Bezeichner
  base = base.replace(/\d+$/, "") || "v";
  if (!/^\w+$/.test(base) || /^(t|tr|de|n|s)$/.test(base)) base = "v";
  let name = base, i = 2; while (used.has(name)) name = base + i++;
  used.add(name); return name;
}

function candidates(sf, rel) {
  const out = [];
  const visit = (n) => {
    const p = n.parent;
    if (ts.isJsxText(n)) {
      const raw = n.getText(); const text = decode(raw.replace(/\s+/g, " ").trim());
      if (hasText(text)) {
        let code = false; for (let a = p; a; a = a.parent) if (ts.isJsxElement(a) && /^(code|pre|kbd|samp)$/.test(a.openingElement.tagName.getText())) code = true;
        if (!code) {
          if (!inFn(n)) skipped.modul.push(`${rel}: ${text.slice(0, 40)}`);
          else {
            const lead = raw.length - raw.trimStart().length, trail = raw.length - raw.trimEnd().length;
            out.push({ kind: "jsxText", start: n.getStart() + lead, end: n.getEnd() - trail, text });
          }
        }
      }
    } else if (ts.isJsxAttribute(n) && n.initializer && ts.isStringLiteral(n.initializer)) {
      const v = n.initializer.text, name = n.name.getText();
      const inList = ATTRS.has(name) && hasText(v) && !(!v.includes(" ") && /[/:._@]/.test(v));
      const prose = !ATTRS.has(name) && v.includes(" ") && germanish(v) && !/^[a-z0-9 _:\-]+$/.test(v);
      if (inList || prose) { if (inFn(n)) out.push({ kind: "attr", start: n.initializer.getStart(), end: n.initializer.getEnd(), text: v }); else skipped.modul.push(`${rel}: ${v.slice(0, 40)}`); }
    } else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
      considerLiteral(n, p, out, rel);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf); return out;
}

function considerLiteral(n, p, out, rel) {
  { const sf = n.getSourceFile(); const ln = sf.getLineAndCharacterOfPosition(n.getStart()).line; if (sf.text.split("\n")[ln].includes("i18n-keep")) return; }   // Zeile bewusst ausgenommen (Wert ist Logik, nicht Anzeige)
  if (ts.isJsxAttribute(p) || ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isLiteralTypeNode(p) || ts.isExternalModuleReference(p) || ts.isCaseClause(p) || ts.isTaggedTemplateExpression(p)) return;
  if (ts.isPropertyAssignment(p) && p.name === n) return;
  if (ts.isElementAccessExpression(p) && p.argumentExpression === n) return;
  if (ts.isBinaryExpression(p) && /^(===|!==|==|!=)$/.test(p.operatorToken.getText())) return;
  if (ts.isCallExpression(p)) { const c = p.expression.getText().replace(/\s+/g, ""); if (/^(t|tr|N_)$/.test(c) || SKIP_CALLEE.test(c)) return; }
  if (ts.isTemplateSpan(p)) return;
  const tpl = ts.isTemplateExpression(n);
  const staticText = tpl ? [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(" ") : n.text;
  let ok = staticText.includes(" ") && germanish(staticText) && staticText.length > 3;
  if (!ok && !tpl && capWord(n.text)) {   // Einzelwörter nur an sicheren Anzeigestellen
    const viaCond = (ts.isConditionalExpression(p) || (ts.isBinaryExpression(p) && /^(\?\?|\|\|)$/.test(p.operatorToken.getText()))) && (ts.isJsxExpression(p.parent) || ts.isJsxAttribute(p.parent) || ts.isConditionalExpression(p.parent));
    const viaProp = ts.isPropertyAssignment(p) && DISPLAY_PROPS.has(p.name.getText());
    ok = viaCond || viaProp;
  }
  if (!ok && LAX && !tpl && laxOk(n, p)) { ok = true; const k = JSON.stringify(n.text) + "  " + ts.SyntaxKind[p.kind].replace("Expression", "") + (ts.isPropertyAssignment(p) ? ":" + p.name.getText() : ts.isCallExpression(p) ? ":" + p.expression.getText().slice(0, 20) : ""); laxLog.set(k, (laxLog.get(k) || 0) + 1); }
  if (!ok) return;
  if (!tpl && COMPARED.has(n.text) && (hasText(n.text))) { skipped.verglichen.push(`${rel}: ${n.text.slice(0, 40)}`); return; }
  if (!inFn(n)) {
    if (!tpl && ts.isPropertyAssignment(p) && p.initializer === n && ts.isObjectLiteralExpression(p.parent) && !ts.isComputedPropertyName(p.name)) { out.push({ kind: "getter", start: p.getStart(), end: p.getEnd(), text: n.text, name: p.name.getText() }); return; }   // Getter: übersetzt beim Zugriff, nicht beim Import
    skipped.modul.push(`${rel}: ${ts.SyntaxKind[p.kind]} ${staticText.replace(/\s+/g, " ").slice(0, 40)}`); return;
  }
  if (!tpl) { out.push({ kind: "literal", start: n.getStart(), end: n.getEnd(), text: n.text }); return; }
  if (/\{\w+\}/.test(staticText)) { skipped.brace.push(`${rel}: ${staticText.slice(0, 40)}`); return; }
  out.push({ kind: "template", start: n.getStart(), end: n.getEnd(), tpl: n });
}

function render(c, alias) {
  if (c.kind === "jsxText") return `{${alias}(${JSON.stringify(c.text)})}`;
  if (c.kind === "attr") return `{${alias}(${JSON.stringify(c.text)})}`;
  if (c.kind === "getter") return `get ${c.name}() { return ${alias}(${JSON.stringify(c.text)}); }`;
  if (c.kind === "literal") return `${alias}(${JSON.stringify(c.text)})`;
  const n = c.tpl, used = new Set(), vars = []; let key = n.head.text;
  for (const s of n.templateSpans) { const name = placeholderName(s.expression, used); vars.push(ts.isIdentifier(s.expression) && s.expression.text === name ? name : `${name}: ${s.expression.getText()}`); key += `{${name}}` + s.literal.text; }
  return `${alias}(${JSON.stringify(key)}, { ${vars.join(", ")} })`;
}

const importPath = (f) => { const r = path.relative(path.dirname(f), path.join(SRC, "i18n")); return r.startsWith(".") ? r : "./" + r; };
let changedFiles = 0;
for (const f of files) {
  let text = fs.readFileSync(f, "utf8"); const rel = path.relative(SRC, f);
  const alias = declaresT(ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)) ? "tr" : "t";
  let any = false;
  for (let pass = 0; pass < 6; pass++) {
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    let cs = candidates(sf, rel);
    cs = cs.filter((a) => !cs.some((b) => b !== a && b.start >= a.start && b.end <= a.end));   // innere zuerst
    if (!cs.length) break;
    cs.sort((a, b) => b.start - a.start);
    for (const c of cs) { text = text.slice(0, c.start) + render(c, alias) + text.slice(c.end); stats[c.kind]++; }
    any = true;
  }
  // Modul-/Doppelmeldungen aus späteren Durchläufen entfernen wir nicht, sie sind nur Hinweise.
  if (!any) continue;
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const imp = alias === "t" ? "t" : "t as tr";
  const lastImport = sf.statements.filter(ts.isImportDeclaration).pop();
  const line = `import { ${imp} } from "${importPath(f)}";`;
  const has = /from "(\.\.?\/)+i18n"/.test(text);
  if (!has) text = lastImport ? text.slice(0, lastImport.getEnd()) + "\n" + line + text.slice(lastImport.getEnd()) : line + "\n" + text;
  changedFiles++;
  if (WRITE) fs.writeFileSync(f, text);
}
const dedupe = (a) => [...new Set(a)];
console.log(WRITE ? "GESCHRIEBEN" : "PROBELAUF", stats, "Dateien:", changedFiles);
for (const [k, v] of Object.entries(skipped)) { const d = dedupe(v); console.log(`\n== ausgelassen (${k}): ${d.length}`); d.slice(0, 200).forEach((x) => console.log("  ", x)); }

if (RESIDUAL) {   // nach dem Umbau: noch ungewrappte Texte an Anzeigestellen mit lockerer Regel (auch Einzelwörter klein), zur Durchsicht
  const seen = new Map();
  for (const f of files) {
    const sf = ts.createSourceFile(f, fs.readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const v = (n) => {
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && inFn(n) && hasText(n.text) && !/[/:._@#=<>{}\\]/.test(n.text) && n.text.length > 2) {
        const p = n.parent;
        const skip = ts.isJsxAttribute(p) || ts.isImportDeclaration(p) || ts.isLiteralTypeNode(p) || ts.isCaseClause(p) || (ts.isPropertyAssignment(p) && p.name === n) || ts.isElementAccessExpression(p) || (ts.isBinaryExpression(p) && /^(===|!==|==|!=)$/.test(p.operatorToken.getText())) || (ts.isCallExpression(p) && (/^(t|tr|N_)$/.test(p.expression.getText()) || SKIP_CALLEE.test(p.expression.getText()))) || ts.isExportDeclaration(p);
        if (!skip) { const k = n.text; if (!seen.has(k)) seen.set(k, { n: 0, ctx: ts.SyntaxKind[p.kind] + (ts.isPropertyAssignment(p) ? ":" + p.name.getText() : ""), file: path.relative(SRC, f) }); seen.get(k).n++; }
      }
      ts.forEachChild(n, v);
    };
    v(sf);
  }
  console.log("\n== REST", seen.size);
  for (const [k, v] of seen) console.log(`${v.n}\t${JSON.stringify(k)}\t${v.ctx}\t${v.file}`);
}

if (LAX) { console.log("\n== lax umhüllt:", laxLog.size); for (const k of laxLog.keys()) console.log("  ", k); }
