import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { PageHead } from "../components/PageHead";
import { useAction } from "../components/useAction";
import type { AgentRef, SaPreview, SaStats, SaTimeline } from "../types";
import { t } from "../i18n";

export default function SessionsAdminPage({ agent }: { agent: AgentRef }) {
  const [stats, setStats] = useState<SaStats | null>(null);
  const [empty, setEmpty] = useState<number | null>(null);
  const [days, setDays] = useState("90");
  const [preview, setPreview] = useState<SaPreview | null>(null);
  const [typedPrune, setTypedPrune] = useState("");
  const [typedEmpty, setTypedEmpty] = useState("");
  const [done, setDone] = useState("");
  const [loadErr, setLoadErr] = useState("");
  const [sid, setSid] = useState("");
  const [tl, setTl] = useState<SaTimeline | null>(null);
  const [impSessions, setImpSessions] = useState<Array<Record<string, unknown>> | null>(null);
  const [typedImp, setTypedImp] = useState("");
  const { run, notes, busy } = useAction();

  const load = useCallback(async () => {
    const [s, e] = await Promise.all([api.saStats(agent), api.saEmpty(agent)]);
    setStats(s); setEmpty(e.count);
  }, [agent]);
  useEffect(() => { load().catch((e) => setLoadErr((e as Error).message)); }, [load]);

  const n = Number(days);
  const daysOk = Number.isFinite(n) && n >= 1 && n <= 3650; // 0 Tage träfe alles
  return (
    <article>
      <PageHead title={t("Sitzungen verwalten")} sub={stats ? `${stats.total} Sitzungen, ${stats.messages} Nachrichten` : t("lädt …")} />
      {notes}
      {loadErr && <p className="banner" role="alert">{loadErr}</p>}
      {done && <p role="status">{done}</p>}
      <section aria-label={t("Aufräumen")}>
        <h2>{t("Alte Sitzungen aufräumen")}</h2>
        <label>{t("Älter als (Tage)")} <input aria-label={t("Älter als (Tage)")} inputMode="numeric" value={days} onChange={(e) => { setDays(e.target.value); setPreview(null); setTypedPrune(""); }} /></label>
        {!daysOk && <p className="banner">{t("Mindestens 1 Tag, höchstens 3650.")}</p>}
        <button type="button" disabled={busy || !daysOk} onClick={() => void run(async () => { setPreview(await api.saPreview(agent, n)); setTypedPrune(""); setDone(""); })}>{t("Vorschau")}</button>
        {preview && (
          <div>
            <p>{t("{matched} Sitzungen würden gelöscht, {skipped_open} laufende bleiben.", { matched: preview.matched, skipped_open: preview.skipped_open })}</p>
            <ul>{preview.sample.map((s) => <li key={s.id}>{s.title}</li>)}</ul>
            <label>{t("Zur Bestätigung die Anzahl eingeben")} <input aria-label={t("Anzahl bestätigen")} value={typedPrune} onChange={(e) => setTypedPrune(e.target.value)} /></label>
            <button type="button" disabled={busy || preview.matched === 0 || typedPrune !== String(preview.matched)} onClick={() => void run(async () => { const r = await api.saPrune(agent, n, preview.matched); setDone(t("{removed} Sitzungen gelöscht.", { removed: r.removed })); setPreview(null); setTypedPrune(""); await load(); })}>{t("Jetzt löschen")}</button>
          </div>
        )}
      </section>
      <section aria-label={t("Leere Sitzungen")}>
        <h2>{t("Leere Sitzungen")}</h2>
        <p>{t("{empty} leere, beendete Sitzungen.", { empty: empty ?? "…" })}</p>
        <label>{t("Zur Bestätigung die Anzahl eingeben")} <input aria-label={t("Leere bestätigen")} value={typedEmpty} onChange={(e) => setTypedEmpty(e.target.value)} /></label>
        <button type="button" disabled={busy || !empty || typedEmpty !== String(empty)} onClick={() => void run(async () => { const r = await api.saEmptyDelete(agent, typedEmpty); setDone(t("{deleted} leere Sitzungen gelöscht.", { deleted: r.deleted })); setTypedEmpty(""); await load(); })}>{t("Leere löschen")}</button>
      </section>
      <section aria-label={t("Zeitachse")}>
        <h2>{t("Zeitachse einer Sitzung")}</h2>
        <label>{t("Sitzungs-ID")} <input aria-label={t("Sitzungs-ID")} value={sid} onChange={(e) => { setSid(e.target.value); setTl(null); }} /></label>
        <button type="button" disabled={busy || !sid.trim()} onClick={() => void run(async () => setTl(await api.saTimeline(agent, sid.trim())))}>{t("Zeitachse laden")}</button>
        {tl && (tl.events.length === 0 ? <p>{t("Keine Ereignisse.")}</p> : <ul>{tl.events.map((e) => <li key={e.row_id ?? e.summary}><span className="mono small">{e.type}</span> {e.summary}</li>)}</ul>)}
      </section>
      <section aria-label={t("Sitzungen importieren")}>
        <h2>{t("Sitzungen importieren")}</h2>
        <label>{t("Exportdatei")} <input type="file" accept=".json,application/json" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; setImpSessions(null); setTypedImp(""); if (!f) return; void run(async () => {
          let parsed: unknown; try { parsed = JSON.parse(await f.text()); } catch { throw new Error(t("Ungültige Importdatei")); }
          const list = Array.isArray(parsed) ? parsed : (parsed as { sessions?: unknown }).sessions;
          if (!Array.isArray(list)) throw new Error(t("Ungültige Importdatei"));
          setImpSessions(list as Array<Record<string, unknown>>);
        }); e.target.value = ""; }} /></label>
        {impSessions && <>
          <p>{t("{n} Sitzungen in der Datei.", { n: impSessions.length })}</p>
          <label>{t("Zur Bestätigung die Anzahl eingeben")} <input aria-label={t("Anzahl bestätigen")} value={typedImp} onChange={(e) => setTypedImp(e.target.value)} /></label>
          <button type="button" disabled={busy || impSessions.length === 0 || typedImp !== String(impSessions.length)} onClick={() => void run(async () => { const r = await api.saImport(agent, impSessions, impSessions.length); setDone(t("{imported} Sitzungen importiert.", { imported: r.imported })); setImpSessions(null); setTypedImp(""); await load(); })}>{t("Jetzt importieren")}</button>
        </>}
      </section>
      <section aria-label={t("Alte Sitzungen zuordnen")}>
        <h2>{t("Alte Sitzungen zuordnen")}</h2>
        <p>{t("Ordnet alte Sitzungen ohne Profil diesem Profil zu.")}</p>
        <button type="button" disabled={busy} onClick={() => { if (window.confirm(t("Alte Sitzungen ohne Profil diesem Profil zuordnen? Fortfahren?"))) void run(async () => { const r = await api.saBackfill(agent); setDone(t("{stamped} Sitzungen zugeordnet.", { stamped: r.stamped ?? 0 })); }); }}>{t("Jetzt zuordnen")}</button>
      </section>
    </article>
  );
}
