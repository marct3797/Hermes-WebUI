import { useState } from "react";
import { cronApi, type Job, type JobInput, type Run, type Target } from "../../opsApi";
import { fmtDuration } from "../../format";
import { Icon } from "../Icon";
import { useAsync } from "../../useAsync";
import { Confirm } from "./Confirm";
import { ErrBanner } from "./ErrBanner";
import { JobForm, stamp } from "./JobForm";
import { t } from "../../i18n";

export function statusOf(j: Job): { key: "active" | "paused" | "error" | "done"; label: string } {
  if (j.state === "completed") return { key: "done", label: t("Beendet") };
  if (!j.enabled || j.state === "paused") return { key: "paused", label: t("Pausiert") };
  if (j.failure_streak > 0 || (j.last_status != null && j.last_status !== "ok")) return { key: "error", label: t("Fehler") };
  return { key: "active", label: t("Aktiv") };
}

function Runs({ host, profile, id, revision }: { host: string; profile: string; id: string; revision: number }) {
  const runs = useAsync(() => cronApi.runs(host, profile, id), [host, profile, id, revision]);
  const at = (s: number | null) => (s == null ? "–" : new Date(s * 1000).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  return (
    <section className="kn-sec" aria-label={t("Laufverlauf")}>
      <h2>{t("Laufverlauf")}</h2>
      {runs.loading && <p className="muted small">{t("Lade…")}</p>}
      {runs.error && <p className="banner" role="alert"><Icon name="alert" /><span>{t("Laufverlauf nicht ladbar: {error}", { error: runs.error })}</span></p>}
      {runs.data && runs.data.runs.length === 0 && <p className="panel-empty">{t("Noch keine Läufe aufgezeichnet.")}</p>}
      {runs.data && runs.data.runs.length > 0 && (
        <div className="kn-table-scroll"><table className="tbl">
          <thead><tr><th>{t("Beginn")}</th><th>{t("Dauer")}</th><th>{t("Ergebnis")}</th></tr></thead>
          <tbody>{runs.data.runs.map((r: Run) => (
            <tr key={r.id}>
              <td className="mono small">{at(r.started_at)}</td>
              <td className="mono small">{r.duration_s == null ? "–" : fmtDuration(r.duration_s * 1000)}</td>
              <td><details><summary><span className={`tag${r.status === "FAILED" ? " err" : ""}`}>{r.active ? "läuft" : r.status ?? t("unbekannt")}</span></summary><pre className="jobs-pre">{r.preview || t("Keine Ausgabe.")}</pre></details></td>
            </tr>))}</tbody>
        </table></div>)}
    </section>
  );
}

/** Detailansicht eines Zeitplans: bearbeiten, aktivieren/pausieren, jetzt ausführen, löschen, Laufverlauf. */
export function JobPanel({ host, profile, job, targets, skills, onChanged, onClose }: {
  host: string; profile: string; job: Job; targets: Target[]; skills: string[]; onChanged: (deleted?: boolean) => void; onClose: () => void;
}) {
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<unknown>();
  const [note, setNote] = useState<string>();
  const [sure, setSure] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [runsRev, setRunsRev] = useState(0);
  const st = statusOf(job);
  const locked = job.system && !unlocked;
  const run = async (what: string, fn: () => Promise<unknown>, done?: string, after?: () => void) => {
    setBusy(what); setErr(undefined); setNote(undefined);
    try { await fn(); if (done) setNote(done); after?.(); onChanged(); } catch (e) { setErr(e); } finally { setBusy(undefined); }
  };
  const save = (body: JobInput) => run("save", () => cronApi.update(host, profile, job.id, { ...body, ...(job.system ? { confirm_system: true } : {}) }), "Gespeichert.");
  const toggle = () => run("toggle", () => cronApi.act(host, profile, job.id, job.enabled ? "pause" : "resume"), job.enabled ? "Pausiert." : "Aktiviert.");
  const trigger = () => run("trigger", () => cronApi.act(host, profile, job.id, "trigger", job.system), "Lauf gestartet.", () => setRunsRev((n) => n + 1));
  const remove = async () => {
    setDeleting(true); setErr(undefined);
    try { await cronApi.remove(host, profile, job.id, job.system); setSure(false); onChanged(true); } catch (e) { setErr(e); setSure(false); } finally { setDeleting(false); }
  };
  return (
    <section className="card jobs-panel" aria-label={`Zeitplan ${job.name || job.id}`}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <h2 className="grow trunc" style={{ margin: 0 }}>{job.name || t("Ohne Namen")}</h2>
        <span className={`tag jobs-st-${st.key}`}>{st.label}</span>
        <button type="button" className="btn btn-s" onClick={onClose} aria-label={t("Detailansicht schließen")}><Icon name="x" size={14} /></button>
      </div>
      <p className="hint mono" style={{ margin: 0 }}>{t("{id} · Zeitplan {display} · nächster Lauf {next_run_at} · letzter Lauf {last_run_at}{last_status}", { id: job.id, display: job.schedule.display ?? t("unbekannt"), next_run_at: stamp(job.next_run_at), last_run_at: stamp(job.last_run_at), last_status: job.last_status ? ` (${job.last_status})` : "" })}</p>
      {job.paused_reason && <p className="hint" style={{ margin: 0 }}>{t("Pausiert: {paused_reason}", { paused_reason: job.paused_reason })}</p>}
      {job.last_error && <p className="banner" role="status"><Icon name="alert" /><span>{t("Letzter Fehler: {last_error}", { last_error: job.last_error })}</span></p>}
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-s" disabled={!!busy || st.key === "done"} onClick={() => void toggle()}>{job.enabled && job.state !== "paused" ? t("Pausieren") : t("Aktivieren")}</button>
        <button type="button" className="btn btn-s" disabled={!!busy || (locked && job.system)} onClick={() => void trigger()}><Icon name="play" size={14} />{t("Jetzt ausführen")}</button>
        <button type="button" className="btn btn-s" disabled={!!busy || locked} onClick={() => setSure(true)}><Icon name="x" size={14} />{t("Löschen")}</button>
      </div>
      {job.system && (
        <div className="banner" role="note"><Icon name="alert" /><span>{t("System-Job: läuft als Skript")} <code>{job.script ?? t("ohne Namen")}</code> {t("ohne Agent. Änderungen, Ausführen und Löschen können den Betrieb stören.")}{" "}
          <label className="row" style={{ gap: 6, display: "inline-flex" }}><input type="checkbox" checked={unlocked} onChange={(e) => setUnlocked(e.target.checked)} /><span>{t("Ich ändere diesen System-Job bewusst")}</span></label></span></div>)}
      <ErrBanner err={err} />
      {note && <p className="hint crimt" role="status" style={{ margin: 0 }}>{note}</p>}
      <JobForm key={job.id + job.next_run_at + job.schedule.display + job.deliver + job.name + job.prompt} job={job} targets={targets} skills={skills} locked={locked} busy={busy === "save"} label={t("Änderungen speichern")} onSubmit={(b) => void save(b)} />
      <Runs host={host} profile={profile} id={job.id} revision={runsRev} />
      {sure && (
        <Confirm title={t("Zeitplan löschen?")} label={t("Endgültig löschen")} busy={deleting} onConfirm={() => void remove()} onClose={() => setSure(false)}>
          <p style={{ margin: 0 }}><b>{job.name || job.id}</b> <span className="mono small t3">({job.id})</span></p>
          <p className="hint" style={{ margin: 0 }}>{t("Der Zeitplan und seine Einstellungen werden entfernt. Das lässt sich nicht rückgängig machen.")}</p>
        </Confirm>)}
    </section>
  );
}
