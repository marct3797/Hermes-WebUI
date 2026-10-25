import { useState } from "react";
import { hostApi, type KbDiag, type KbDispatch, type KbWorker } from "../p3Api";
import { useAction } from "./useAction";

/** Diagnose, laufende Worker, Dispatch (erst Vorschau), Schätzen und Spezifizieren. Läuft unter dem Board, beeinflusst es aber nur über das Dashboard. */
export function KanbanAdminPanel({ host, board }: { host: string; board?: string }) {
  const [diag, setDiag] = useState<KbDiag | null>(null);
  const [workers, setWorkers] = useState<KbWorker[] | null>(null);
  const [preview, setPreview] = useState<KbDispatch | null>(null);
  const [task, setTask] = useState("");
  const [result, setResult] = useState("");
  const [typed, setTyped] = useState<Record<number, string>>({});
  const { run, notes, busy } = useAction();
  const tid = task.trim();
  return (
    <details className="kb-admin">
      <summary>Diagnose und Betrieb</summary>
      {notes}
      <section aria-label="Diagnose">
        <button type="button" disabled={busy} onClick={() => void run(async () => setDiag(await hostApi.kbDiag(host, board)))}>Diagnose laden</button>
        {diag && (diag.count === 0 ? <p>Keine Auffälligkeiten.</p> : <ul>{diag.items.map((i) => <li key={i.task_id}>{i.task_id} {i.title}: {i.diagnostics.map((d) => `${d.severity}: ${d.title}`).join("; ")}</li>)}</ul>)}
      </section>
      <section aria-label="Worker">
        <button type="button" disabled={busy} onClick={() => void run(async () => setWorkers((await hostApi.kbWorkers(host, board)).workers))}>Laufende Worker laden</button>
        {workers && (workers.length === 0 ? <p>Keine Worker aktiv.</p> : <ul>{workers.map((w) => w.run_id !== null && (
          <li key={w.run_id}>Lauf {w.run_id}, {w.profile}, {w.task_id} {w.title}
            <input aria-label={`Lauf-Nummer zum Beenden ${w.run_id}`} placeholder={String(w.run_id)} value={typed[w.run_id] ?? ""} onChange={(e) => setTyped({ ...typed, [w.run_id!]: e.target.value })} />
            <button type="button" disabled={busy || typed[w.run_id] !== String(w.run_id)} onClick={() => void run(async () => { await hostApi.kbTerminate(host, w.run_id!, board); setWorkers((await hostApi.kbWorkers(host, board)).workers); })}>Lauf {w.run_id} beenden</button>
          </li>))}</ul>)}
      </section>
      <section aria-label="Dispatch">
        <button type="button" disabled={busy} onClick={() => void run(async () => setPreview(await hostApi.kbDispatch(host, true, board)))}>Vorschau: was würde starten?</button>
        {preview && <p>{preview.spawned.length} würden starten ({preview.spawned.join(", ") || "keine"}), {preview.promoted.length} würden bereit werden.</p>}
        <button type="button" disabled={busy || !preview || preview.spawned.length === 0} onClick={() => void run(async () => { const r = await hostApi.kbDispatch(host, false, board); setPreview(null); setResult(`${r.spawned.length} Worker gestartet`); })}>Worker jetzt starten</button>
      </section>
      <section aria-label="Aufgabe verbessern">
        <label>Aufgaben-ID <input aria-label="Aufgaben-ID" value={task} onChange={(e) => setTask(e.target.value)} /></label>
        <button type="button" disabled={busy || !tid} onClick={() => void run(async () => { const r = await hostApi.kbEstimate(host, tid, board); setResult(r.ok ? `Schätzung: ${r.est_tokens ?? "?"} Tokens, Komplexität ${r.complexity}. ${r.rationale}` : `Keine Schätzung: ${r.reason}`); })}>Aufwand schätzen</button>
        <button type="button" disabled={busy || !tid} onClick={() => { if (window.confirm("Spezifizieren schreibt Titel und Beschreibung der Aufgabe um. Fortfahren?")) void run(async () => { const r = await hostApi.kbSpecify(host, tid, board); setResult(r.ok ? `Neu formuliert: ${r.new_title}` : `Nicht spezifiziert: ${r.reason}`); }); }}>Aufgabe spezifizieren</button>
      </section>
      {result && <p role="status">{result}</p>}
    </details>
  );
}
