// Übersetzungsarbeit in Stücken.   node scripts/i18n-chunks.mjs split <ordner> [größe]   teilt _keys.json in <ordner>/chunks/NN.json (Listen deutscher Texte)
//                                  node scripts/i18n-chunks.mjs merge <sprache> <ordner>  fügt <ordner>/out/<sprache>/NN.json (Objekte {deutsch: übersetzt}) zu src/locales/<sprache>.json zusammen und prüft
import fs from "node:fs";
import path from "node:path";
import { LOCALES, checkLocale, collectKeys } from "./i18n-keys.mjs";

const [cmd, a, b, c] = process.argv.slice(2);
if (cmd === "split") {
  const dir = path.join(a, "chunks"); fs.mkdirSync(dir, { recursive: true });
  const size = Number(b ?? 150), keys = collectKeys();
  for (let i = 0; i * size < keys.length; i++) fs.writeFileSync(path.join(dir, String(i).padStart(2, "0") + ".json"), JSON.stringify(keys.slice(i * size, (i + 1) * size), null, 1));
  console.log(keys.length, "Schlüssel in", Math.ceil(keys.length / size), "Stücken:", dir);
} else if (cmd === "merge") {
  const dir = path.join(b, "out", a), merged = {};
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).sort() : [];
  for (const f of names) Object.assign(merged, JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  const keys = collectKeys(); const ordered = {}; for (const k of keys) if (k in merged) ordered[k] = merged[k];
  fs.mkdirSync(LOCALES, { recursive: true }); fs.writeFileSync(path.join(LOCALES, `${a}.json`), JSON.stringify(ordered, null, 1) + "\n");
  const r = checkLocale(a, keys);
  console.log(`${a}: ${Object.keys(ordered).length} von ${keys.length} übersetzt aus ${names.length} Stücken`);
  for (const [k, v] of Object.entries(r)) if (k !== "same") console.log(`  ${k}: ${v.length}`, v.slice(0, 4).map((x) => JSON.stringify(x.slice(0, 70))).join(" | "));
  console.log(`  gleich wie deutsch (nur Hinweis): ${r.same.length}`);
} else console.log("split <ordner> [größe] | merge <sprache> <ordner>");
