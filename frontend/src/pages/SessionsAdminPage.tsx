import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { PageHead } from "../components/PageHead";
import { StepUpNote } from "../components/providers/StepUpNote";
import type { AgentRef, SaPreview, SaStats } from "../types";

function useAction() {
  const [error, setError] = useState<string>();
  const [stepUp, setStepUp] = useState(false);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true); setError(undefined); setStepUp(false); setMissing(false);
    try { await fn(); return true; }
    catch (e) {
      if (e instanceof ApiError && e.code === "step_up_required") setStepUp(true);
      else if (e instanceof ApiError && e.status === 501) setMissing(true);
      else setError((e as Error).message);
      return false;
    }
    finally { setBusy(false); }
  };
  const notes = <>{stepUp && <StepUpNote what="Diese Änderung" />}{missing && <p className="banner">Für diese Runtime ist kein Dashboard eingerichtet.</p>}{error && <p className="banner" role="alert">{error}</p>}</>;
  return { run, notes, busy };
}

export default function SessionsAdminPage({ agent }: { agent: AgentRef }) {
  const [stats, setStats] = useState<SaStats | null>(null);
  const [empty, setEmpty] = useState<number | null>(null);
  const [days, setDays] = useState("90");
  const [preview, setPreview] = useState<SaPreview | null>(null);
  const [typedPrune, setTypedPrune] = useState("");
  const [typedEmpty, setTypedEmpty] = useState("");
  const [done, setDone] = useState("");
  const { run, notes, busy } = useAction();

  const load = useCallback(async () => {
    const [s, e] = await Promise.all([api.saStats(agent), api.saEmpty(agent)]);
    setStats(s); setEmpty(e.count);
  }, [agent]);
  useEffect(() => { void load().catch(() => undefined); }, [load]);

  const n = Number(days);
  const daysOk = Number.isFinite(n) && n >= 1 && n <= 3650; // 0 Tage träfe alles
  return (
    <article>
      <PageHead title="Sitzungen verwalten" sub={stats ? `${stats.total} Sitzungen, ${stats.messages} Nachrichten` : "lädt …"} />
      {notes}
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
