import { useState } from "react";
import { api } from "../api";
import type { AgentRef } from "../types";
import { t } from "../i18n";
import { useAction } from "../useAction";

type Receipt = Record<string, string | number | boolean> | null;

function size(n: number | null): string {
  if (n === null) return "?";
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

function Typed({ word, busy, label, onGo, danger }: { word: string; busy: boolean; label: string; onGo: () => void; danger?: boolean }) {
  const [v, setV] = useState("");
  return (
    <>
      <label>{t("Zum Bestätigen „")}{word}{t("“ eintippen")} <input className="field field-line" value={v} onChange={(e) => setV(e.target.value)} autoComplete="off" /></label>
      <div><button type="button" className={danger ? "btn btn-danger" : "btn"} disabled={busy || v !== word} onClick={onGo}>{label}</button></div>
    </>
  );
}

/** Weitere Betriebsfunktionen eines Agents: Checkpoints, Sicherheitsprüfung, Gateway leeren, Update-Beleg, Konfiguration lesen. */
export function OpsMore({ agent, agentName }: { agent: AgentRef; agentName: string }) {
  const cp = useAction(), au = useAction(), dr = useAction(), rc = useAction(), cf = useAction();
  const [points, setPoints] = useState<{ session: string; files: number | null; bytes: number | null }[]>();
  const [total, setTotal] = useState<number | null>(null);
  const [pruning, setPruning] = useState(false);
  const [pruneLog, setPruneLog] = useState<string>();
  const [audit, setAudit] = useState<string>();
  const [draining, setDraining] = useState(false);
  const [drainMsg, setDrainMsg] = useState<string>();
  const [receipt, setReceipt] = useState<Receipt | "none">();
  const [view, setView] = useState<{ kind: "raw" | "defaults"; text: string; redacted?: boolean }>();

  return (
    <>
      <section className="card tool-panel" role="region" aria-label={t("Checkpoints")}>
        <b>{t("Checkpoints")}</b>
        <p className="muted small" style={{ margin: 0 }}>{t("Wiederherstellungspunkte für /rollback. Die Liste zeigt nur Sitzung, Dateizahl und Größe, nie Pfade.")}</p>
        <div className="row">
          <button type="button" className="btn" disabled={cp.busy} onClick={() => void cp.run(async () => { const r = await api.omCheckpoints(agent); setPoints(r.sessions); setTotal(r.total_bytes); })}>{t("Laden")}</button>
          {points && points.length > 0 && <button type="button" className="btn btn-danger" disabled={cp.busy} onClick={() => setPruning(!pruning)}>{t("Aufräumen")}</button>}
        </div>
        {points && <p className="muted small" style={{ margin: 0 }}>{points.length === 0 ? t("Keine Checkpoints.") : t("{n} Sitzungen, {size}", { n: points.length, size: size(total) })}</p>}
        {points && points.length > 0 && <ul className="plain">{points.map((p) => <li key={p.session} className="muted small">{p.session}: {t("{n} Dateien", { n: p.files ?? 0 })}, {size(p.bytes)}</li>)}</ul>}
        {pruning && <Typed word={agentName} busy={cp.busy} label={t("Endgültig aufräumen")} danger onGo={() => void cp.run(async () => {
          await api.omPrune(agent, agentName); setPruning(false); setPruneLog((await api.omAction(agent, "checkpoints-prune")).log);
          const r = await api.omCheckpoints(agent); setPoints(r.sessions); setTotal(r.total_bytes);
        })} />}
        {pruneLog && <pre className="log">{pruneLog}</pre>}
        {cp.notes}
      </section>

      <section className="card tool-panel" role="region" aria-label={t("Sicherheitsprüfung")}>
        <b>{t("Sicherheitsprüfung")}</b>
        <p className="muted small" style={{ margin: 0 }}>{t("Startet die Prüfung von Hermes und zeigt die geschwärzte Ausgabe. Sie verändert nichts.")}</p>
        <div><button type="button" className="btn" disabled={au.busy} onClick={() => void au.run(async () => { await api.omAudit(agent); setAudit((await api.omAction(agent, "security-audit")).log); })}>{t("Prüfung starten")}</button></div>
        {audit !== undefined && <pre className="log">{audit || t("Keine Ausgabe.")}</pre>}
        {au.notes}
      </section>

      <section className="card tool-panel" role="region" aria-label={t("Gateway leeren")}>
        <b>{t("Gateway leeren")}</b>
        <p className="muted small" style={{ margin: 0 }}>{t("Das Gateway beendet laufende Läufe und nimmt keine neuen an, bis es neu startet. Das Abbrechen geht jederzeit.")}</p>
        <div className="row">
          <button type="button" className="btn btn-danger" disabled={dr.busy} onClick={() => setDraining(!draining)}>{t("Leeren")}</button>
          <button type="button" className="btn" disabled={dr.busy} onClick={() => void dr.run(async () => { const r = await api.omDrain(agent, "cancel"); setDrainMsg(r.was_draining ? t("Leeren abgebrochen.") : t("Es lief kein Leeren.")); })}>{t("Leeren abbrechen")}</button>
        </div>
        {draining && <Typed word="leeren" busy={dr.busy} label={t("Gateway leeren")} danger onGo={() => void dr.run(async () => { await api.omDrain(agent, "drain", "leeren"); setDraining(false); setDrainMsg(t("Das Gateway wird geleert.")); })} />}
        {drainMsg && <p className="muted small" role="status">{drainMsg}</p>}
        {dr.notes}
      </section>

      <section className="card tool-panel" role="region" aria-label={t("Update-Beleg")}>
        <b>{t("Update-Beleg")}</b>
        <div><button type="button" className="btn" disabled={rc.busy} onClick={() => void rc.run(async () => { setReceipt((await api.omReceipt(agent)).receipt ?? "none"); })}>{t("Laden")}</button></div>
        {receipt === "none" && <p className="muted small">{t("Seit Einführung der Belege lief kein Update.")}</p>}
        {receipt && receipt !== "none" && <dl className="plain small">{Object.entries(receipt).map(([k, v]) => <div key={k}><dt className="muted">{k}</dt><dd style={{ margin: 0 }}>{String(v)}</dd></div>)}</dl>}
        {rc.notes}
      </section>

      <section className="card tool-panel" role="region" aria-label={t("Konfiguration lesen")}>
        <b>{t("Konfiguration lesen")}</b>
        <p className="muted small" style={{ margin: 0 }}>{t("Rohe config.yaml und Standardwerte, nur zur Ansicht. Geheimnisse und Pfade sind entfernt. Ändern geht über die Einstellungsseite.")}</p>
        <div className="row">
          <button type="button" className="btn" disabled={cf.busy} onClick={() => void cf.run(async () => { const r = await api.omRaw(agent); setView({ kind: "raw", text: r.yaml, redacted: r.redacted }); })}>{t("config.yaml")}</button>
          <button type="button" className="btn" disabled={cf.busy} onClick={() => void cf.run(async () => { const r = await api.omDefaults(agent); setView({ kind: "defaults", text: JSON.stringify(r.defaults, null, 2) }); })}>{t("Standardwerte")}</button>
        </div>
        {view?.redacted && <p className="muted small">{t("Zeilen mit Geheimnissen sind ausgeblendet.")}</p>}
        {view && <pre className="log" aria-label={view.kind === "raw" ? t("config.yaml") : t("Standardwerte")}>{view.text}</pre>}
        {cf.notes}
      </section>
    </>
  );
}
