import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { PageHead } from "../components/PageHead";
import { useAction } from "../components/useAction";
import type { AgentRef, SaPreview, SaStats } from "../types";
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
    </article>
  );
}
