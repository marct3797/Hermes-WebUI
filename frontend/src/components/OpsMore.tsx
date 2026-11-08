import { useState } from "react";
import { api } from "../api";
import type { AgentRef } from "../types";
import { N_, t } from "../i18n";
import { useAction } from "../useAction";

type Receipt = { followups?: string[]; user_action?: Record<string, string> } & Record<string, unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LABELS: Record<string, string> = { outcome: N_("Ergebnis"), started_at: N_("Gestartet"), finished_at: N_("Beendet"), post_version: N_("Version danach") };

/** Hermes startet diese Aktionen im Hintergrund: nachfragen, bis sie nicht mehr läuft (höchstens ~30 s). */
async function settle(agent: AgentRef, name: "checkpoints-prune" | "security-audit") {
  let r = await api.omAction(agent, name);
  for (let i = 0; r.running && i < 30; i++) { await sleep(1000); r = await api.omAction(agent, name); }
  return r;
}
const outcome = (r: { running: boolean; exit_code: number | null }) =>
  r.running ? t("Die Aktion läuft noch. Später erneut laden.") : r.exit_code ? t("Die Aktion endete mit Fehler (Exit-Code {code}).", { code: r.exit_code }) : undefined;

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
  const [pruneNote, setPruneNote] = useState<string>();
  const [auditNote, setAuditNote] = useState<string>();
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
          {points && points.length > 0 && <button type="button" className="btn btn-danger" disabled={cp.busy} aria-expanded={pruning} onClick={() => setPruning(!pruning)}>{t("Aufräumen")}</button>}
        </div>
        {points && <p className="muted small" style={{ margin: 0 }}>{points.length === 0 ? t("Keine Checkpoints.") : t("{n} Sitzungen, {size}", { n: points.length, size: size(total) })}</p>}
        {points && points.length > 0 && <ul className="plain">{points.map((p) => <li key={p.session} className="muted small">{p.session}: {t("{n} Dateien", { n: p.files ?? 0 })}, {size(p.bytes)}</li>)}</ul>}
        {pruning && <Typed word={agentName} busy={cp.busy} label={t("Endgültig aufräumen")} danger onGo={() => void cp.run(async () => {
          await api.omPrune(agent, agentName); setPruning(false);
          const a = await settle(agent, "checkpoints-prune"); setPruneLog(a.log); setPruneNote(outcome(a));
          const r = await api.omCheckpoints(agent); setPoints(r.sessions); setTotal(r.total_bytes);
        })} />}
        {pruneNote && <p className="banner" role="status">{pruneNote}</p>}
        {pruneLog && <pre className="log">{pruneLog}</pre>}
        {cp.notes}
      </section>

      <section className="card tool-panel" role="region" aria-label={t("Sicherheitsprüfung")}>
        <b>{t("Sicherheitsprüfung")}</b>
        <p className="muted small" style={{ margin: 0 }}>{t("Startet die Prüfung von Hermes und zeigt die geschwärzte Ausgabe. Sie verändert nichts.")}</p>
        <div><button type="button" className="btn" disabled={au.busy} onClick={() => void au.run(async () => { await api.omAudit(agent); const a = await settle(agent, "security-audit"); setAudit(a.log); setAuditNote(outcome(a)); })}>{t("Prüfung starten")}</button></div>
        {auditNote && <p className="banner" role="status">{auditNote}</p>}
        {audit !== undefined && <pre className="log">{audit || t("Keine Ausgabe.")}</pre>}
        {au.notes}
      </section>

      <section className="card tool-panel" role="region" aria-label={t("Gateway leeren")}>
        <b>{t("Gateway leeren")}</b>
        <p className="muted small" style={{ margin: 0 }}>{t("Laufende Läufe laufen zu Ende, neue werden abgewiesen, bis das Gateway neu startet. Das gilt für den ganzen Host, nicht nur für dieses Profil. Das Abbrechen geht jederzeit.")}</p>
        <div className="row">
          <button type="button" className="btn btn-danger" disabled={dr.busy} aria-expanded={draining} onClick={() => setDraining(!draining)}>{t("Leeren")}</button>
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
        {receipt && receipt !== "none" && <>
          <dl className="plain small">{Object.entries(receipt).filter(([k, v]) => k in LABELS && typeof v !== "object").map(([k, v]) => <div key={k}><dt className="muted">{t(LABELS[k])}</dt><dd style={{ margin: 0 }}>{String(v)}</dd></div>)}</dl>
          {!!receipt.followups?.length && <><b className="small">{t("Offene Folgeschritte")}</b><ul className="plain small">{receipt.followups.map((f, i) => <li key={i}>{f}</li>)}</ul></>}
          {!!receipt.user_action && Object.values(receipt.user_action).length > 0 && <p className="banner" role="status"><b>{t("Von dir nötig")}:</b> {Object.values(receipt.user_action).join(" ")}</p>}
        </>}
        {rc.notes}
      </section>

      <section className="card tool-panel" role="region" aria-label={t("Konfiguration lesen")}>
        <b>{t("Konfiguration lesen")}</b>
        <p className="muted small" style={{ margin: 0 }}>{t("Bereinigte Ansicht von config.yaml und der Standardwerte. Geheimnisse, MCP-Umgebung und Pfade sind ersetzt, Kommentare entfallen. Ändern geht über die Einstellungsseite.")}</p>
        <div className="row">
          <button type="button" className="btn" disabled={cf.busy} onClick={() => void cf.run(async () => { const r = await api.omRaw(agent); setView({ kind: "raw", text: r.yaml, redacted: r.redacted }); })}>{t("config.yaml")}</button>
          <button type="button" className="btn" disabled={cf.busy} onClick={() => void cf.run(async () => { const r = await api.omDefaults(agent); setView({ kind: "defaults", text: JSON.stringify(r.defaults, null, 2) }); })}>{t("Standardwerte")}</button>
        </div>
        {view && <pre className="log" aria-label={view.kind === "raw" ? t("config.yaml") : t("Standardwerte")}>{view.text}</pre>}
        {cf.notes}
      </section>
    </>
  );
}
