import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { PageHead } from "../components/PageHead";
import { useAction } from "../components/useAction";
import type { AgentRef, SaPreview, SaStats } from "../types";

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
      <PageHead title="Sitzungen verwalten" sub={stats ? `${stats.total} Sitzungen, ${stats.messages} Nachrichten` : "lädt …"} />
      {notes}
      {loadErr && <p className="banner" role="alert">{loadErr}</p>}
      {done && <p role="status">{done}</p>}
      <section aria-label="Aufräumen">
        <h2>Alte Sitzungen aufräumen</h2>
        <label>Älter als (Tage) <input aria-label="Älter als (Tage)" inputMode="numeric" value={days} onChange={(e) => { setDays(e.target.value); setPreview(null); setTypedPrune(""); }} /></label>
        {!daysOk && <p className="banner">Mindestens 1 Tag, höchstens 3650.</p>}
        <button type="button" disabled={busy || !daysOk} onClick={() => void run(async () => { setPreview(await api.saPreview(agent, n)); setTypedPrune(""); setDone(""); })}>Vorschau</button>
        {preview && (
          <div>
            <p>{preview.matched} Sitzungen würden gelöscht, {preview.skipped_open} laufende bleiben.</p>
            <ul>{preview.sample.map((s) => <li key={s.id}>{s.title}</li>)}</ul>
            <label>Zur Bestätigung die Anzahl eingeben <input aria-label="Anzahl bestätigen" value={typedPrune} onChange={(e) => setTypedPrune(e.target.value)} /></label>
            <button type="button" disabled={busy || preview.matched === 0 || typedPrune !== String(preview.matched)} onClick={() => void run(async () => { const r = await api.saPrune(agent, n, preview.matched); setDone(`${r.removed} Sitzungen gelöscht.`); setPreview(null); setTypedPrune(""); await load(); })}>Jetzt löschen</button>
          </div>
        )}
      </section>
      <section aria-label="Leere Sitzungen">
        <h2>Leere Sitzungen</h2>
        <p>{empty ?? "…"} leere, beendete Sitzungen.</p>
        <label>Zur Bestätigung die Anzahl eingeben <input aria-label="Leere bestätigen" value={typedEmpty} onChange={(e) => setTypedEmpty(e.target.value)} /></label>
        <button type="button" disabled={busy || !empty || typedEmpty !== String(empty)} onClick={() => void run(async () => { const r = await api.saEmptyDelete(agent, typedEmpty); setDone(`${r.deleted} leere Sitzungen gelöscht.`); setTypedEmpty(""); await load(); })}>Leere löschen</button>
      </section>
    </article>
  );
}
