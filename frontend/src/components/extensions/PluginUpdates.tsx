import { useEffect, useState } from "react";
import { extApi } from "../../extApi";
import { useAction } from "../useAction";
import { Switch, type Scope } from "./common";
import { t } from "../../i18n";

const STATUS: Record<string, string> = { updated: "aktualisiert", current: "aktuell", failed: "fehlgeschlagen", needs_review: "braucht deine Prüfung" };
type Outcome = Awaited<ReturnType<typeof extApi.updateAllPlugins>>;

/** Automatische und gesammelte Plugin-Aktualisierung. Beides führt neuen Plugin-Code aus, darum das Bestätigungswort. */
export function PluginUpdates({ scope, onDone }: { scope: Scope; onDone: () => void }) {
  const [auto, setAuto] = useState<boolean | null>(null);
  const [hours, setHours] = useState<number | null>(null);
  const [typed, setTyped] = useState("");
  const [autoWord, setAutoWord] = useState("");
  const [out, setOut] = useState<Outcome | null>(null);
  const { run, notes, busy } = useAction();
  useEffect(() => { extApi.pluginAutoUpdate(scope.host, scope.profile).then((s) => { setAuto(s.auto_apply); setHours(s.check_hours); }, () => setAuto(null)); }, [scope.host, scope.profile]);
  if (auto === null) return null;
  return (
    <section aria-label={t("Plugin-Aktualisierung")} className="card" style={{ padding: 12 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <b className="grow">{t("Plugins aktualisieren")}</b>
        <Switch on={auto} label={t("Automatisch aktualisieren")} onChange={(v) => void run(async () => { const s = await extApi.setPluginAutoUpdate(scope.host, scope.profile, v, v ? autoWord.trim() : undefined); setAuto(s.auto_apply); setHours(s.check_hours); setAutoWord(""); })} />
      </div>
      {!auto && <input className="field field-line" aria-label={t("Zum Einschalten „automatisch“ eintippen")} placeholder={t("automatisch")} value={autoWord} onChange={(e) => setAutoWord(e.target.value)} />}
      <p className="small muted" style={{ margin: "6px 0" }}>{t("Automatisch heißt: neuer Plugin-Code läuft ohne Rückfrage auf dem Host. Die Einstellung gilt für das aktive Profil des Dashboards.")}{hours ? ` ${t("Prüfung alle {h} Stunden.", { h: hours })}` : ""}</p>
      {notes}
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <input className="field field-line" aria-label={t("Zum Aktualisieren „aktualisieren“ eintippen")} placeholder={t("aktualisieren")} value={typed} onChange={(e) => setTyped(e.target.value)} />
        <button type="button" className="btn btn-s" disabled={busy || typed.trim() !== "aktualisieren"} onClick={() => void run(async () => { setOut(await extApi.updateAllPlugins(scope.host, scope.profile, typed.trim())); setTyped(""); onDone(); })}>{t("Alle Plugins aktualisieren")}</button>
      </div>
      {out && (
        <ul role="status" className="small" style={{ margin: "8px 0 0" }}>
          {out.results.map((r) => <li key={r.name}><b>{r.name}</b>: {t(STATUS[r.status] ?? r.status)}{r.detail ? ` (${r.detail})` : ""}{r.status === "needs_review" ? ` ${t("Öffne das Plugin und aktualisiere es einzeln.")}` : ""}</li>)}
          {out.skipped.map((r) => <li key={`s${r.name}`}>{t("{name} übersprungen: {why}", { name: r.name, why: r.reason })}</li>)}
          {!out.results.length && <li>{t("Keine Plugin-Aktualisierung nötig.")}</li>}
        </ul>
      )}
    </section>
  );
}
