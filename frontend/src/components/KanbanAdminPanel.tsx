import { useState } from "react";
import { hostApi, type KbDiag, type KbDispatch, type KbWorker } from "../p3Api";
import { useAction } from "./useAction";
import { t } from "../i18n";

/** Diagnose, laufende Worker, Dispatch (erst Vorschau), Schätzen, Spezifizieren, Zerlegen, Board-Export/Import/Archivieren. Läuft unter dem Board, beeinflusst es aber nur über das Dashboard. */
export function KanbanAdminPanel({ host, board, onChanged, onImported }: { host: string; board?: string; onChanged: () => void; onImported: (slug: string) => void }) {
  const [diag, setDiag] = useState<KbDiag | null>(null);
  const [workers, setWorkers] = useState<KbWorker[] | null>(null);
  const [preview, setPreview] = useState<KbDispatch | null>(null);
  const [task, setTask] = useState("");
  const [result, setResult] = useState("");
  const [typed, setTyped] = useState<Record<number, string>>({});
  const [withAtt, setWithAtt] = useState(true);
  const [withLogs, setWithLogs] = useState(false);
  const [typedBoard, setTypedBoard] = useState("");
  const { run, notes, busy } = useAction();
  const tid = task.trim();
  return (
    <details className="kb-admin">
      <summary>{t("Diagnose und Betrieb")}</summary>
      {notes}
      <section aria-label={t("Diagnose")}>
        <button type="button" disabled={busy} onClick={() => void run(async () => setDiag(await hostApi.kbDiag(host, board)))}>{t("Diagnose laden")}</button>
        {diag && (diag.count === 0 ? <p>{t("Keine Auffälligkeiten.")}</p> : <ul>{diag.items.map((i) => <li key={i.task_id}>{i.task_id} {i.title}: {i.diagnostics.map((d) => `${d.severity}: ${d.title}`).join("; ")}</li>)}</ul>)}
      </section>
      <section aria-label={t("Worker")}>
        <button type="button" disabled={busy} onClick={() => void run(async () => setWorkers((await hostApi.kbWorkers(host, board)).workers))}>{t("Laufende Worker laden")}</button>
        {workers && (workers.length === 0 ? <p>{t("Keine Worker aktiv.")}</p> : <ul>{workers.map((w) => w.run_id !== null && (
          <li key={w.run_id}>{t("Lauf {run_id}, {profile}, {task_id} {title}", { run_id: w.run_id, profile: w.profile, task_id: w.task_id, title: w.title })}<input aria-label={`Lauf-Nummer zum Beenden ${w.run_id}`} placeholder={String(w.run_id)} value={typed[w.run_id] ?? ""} onChange={(e) => setTyped({ ...typed, [w.run_id!]: e.target.value })} />
            <button type="button" disabled={busy || typed[w.run_id] !== String(w.run_id)} onClick={() => void run(async () => { await hostApi.kbTerminate(host, w.run_id!, board); setWorkers((await hostApi.kbWorkers(host, board)).workers); })}>{t("Lauf {run_id} beenden", { run_id: w.run_id })}</button>
          </li>))}</ul>)}
      </section>
      <section aria-label={t("Dispatch")}>
        <button type="button" disabled={busy} onClick={() => void run(async () => setPreview(await hostApi.kbDispatch(host, true, board)))}>{t("Vorschau: was würde starten?")}</button>
        {preview && <p>{t("{v} würden starten ({v2}), {v3} würden bereit werden.", { v: preview.spawned.length, v2: preview.spawned.join(", ") || t("keine"), v3: preview.promoted.length })}</p>}
        <button type="button" disabled={busy || !preview || preview.spawned.length === 0} onClick={() => void run(async () => { const r = await hostApi.kbDispatch(host, false, board); setPreview(null); setResult(`${r.spawned.length} Worker gestartet`); })}>{t("Worker jetzt starten")}</button>
      </section>
      <section aria-label={t("Aufgabe verbessern")}>
        <label>{t("Aufgaben-ID")} <input aria-label={t("Aufgaben-ID")} value={task} onChange={(e) => setTask(e.target.value)} /></label>
        <button type="button" disabled={busy || !tid} onClick={() => void run(async () => { const r = await hostApi.kbEstimate(host, tid, board); setResult(r.ok ? t("Schätzung: {est_tokens} Tokens, Komplexität {complexity}. {rationale}", { est_tokens: r.est_tokens ?? "?", complexity: r.complexity, rationale: r.rationale }) : t("Keine Schätzung: {reason}", { reason: r.reason })); })}>{t("Aufwand schätzen")}</button>
        <button type="button" disabled={busy || !tid} onClick={() => { if (window.confirm(t("Spezifizieren schreibt Titel und Beschreibung der Aufgabe um. Fortfahren?"))) void run(async () => { const r = await hostApi.kbSpecify(host, tid, board); setResult(r.ok ? t("Neu formuliert: {new_title}", { new_title: r.new_title }) : t("Nicht spezifiziert: {reason}", { reason: r.reason })); }); }}>{t("Aufgabe spezifizieren")}</button>
        <button type="button" disabled={busy || !tid} onClick={() => { if (window.confirm(t("Zerlegen legt Kindaufgaben an und verbraucht Tokens des Hilfsmodells. Fortfahren?"))) void run(async () => { const r = await hostApi.kbDecompose(host, tid, board); setResult(r.ok ? t("Zerlegt in: {kids}", { kids: r.child_ids.join(", ") || t("keine") }) : t("Nicht zerlegt: {reason}", { reason: r.reason })); }); }}>{t("Aufgabe zerlegen")}</button>
      </section>
      <section aria-label={t("Board-Archiv")}>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button type="button" disabled={busy || !board} onClick={() => void run(async () => { await hostApi.kbBoardExport(host, board!, withAtt, withLogs); setResult(t("Export gespeichert: {slug}.tar.gz", { slug: board })); })}>{t("Board exportieren")}</button>
          <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={withAtt} onChange={(e) => setWithAtt(e.target.checked)} />{t("Mit Anhängen")}</label>
          <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={withLogs} onChange={(e) => setWithLogs(e.target.checked)} />{t("Mit Logs")}</label>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <label>{t("Archivdatei")} <input type="file" accept=".tar.gz,.tgz,.zip" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void run(async () => { const r = await hostApi.kbBoardImport(host, f); setResult(t("Importiert: {board}", { board: r.board })); onImported(r.board); }); e.target.value = ""; }} /></label>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <label>{t("Board-Namen zur Bestätigung eingeben")} <input aria-label={t("Board-Namen zur Bestätigung eingeben")} value={typedBoard} disabled={busy || !board} onChange={(e) => setTypedBoard(e.target.value)} /></label>
          <button type="button" disabled={busy || !board || typedBoard !== board} onClick={() => void run(async () => { await hostApi.kbBoardDelete(host, board!); setTypedBoard(""); setResult(t("Archiviert: {board}", { board })); onChanged(); })}>{t("Board archivieren")}</button>
        </div>
      </section>
      {result && <p role="status">{result}</p>}
    </details>
  );
}
