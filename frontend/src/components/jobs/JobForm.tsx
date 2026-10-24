import { useState, type FormEvent } from "react";
import { describeInterval, nextRuns } from "../../cronPreview";
import type { Job, JobInput, Target } from "../../opsApi";

const when = (d: Date) => d.toLocaleString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
export const stamp = (iso: string | null) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "–");

export function SchedulePreview({ value }: { value: string }) {
  const v = value.trim();
  if (!v) return null;
  const every = describeInterval(v);
  const runs = every ? null : nextRuns(v, new Date());
  return (
    <p className="hint" role="status" style={{ margin: 0 }}>
      {every ? `Läuft ${every}.` : runs ? `Nächste Läufe (Zeitzone dieses Browsers): ${runs.map(when).join(" · ")}` : "Keine Vorschau möglich. Hermes prüft den Zeitplan beim Speichern."}
    </p>
  );
}

const SCHEDULE_HELP = "Cron mit fünf Feldern (Minute Stunde Tag Monat Wochentag, z. B. 30 4 * * *), Intervall (30m, every 2h) oder einmalig (in 30m, 2026-12-24T08:00).";

/** Formular für neue und bestehende Zeitpläne. Beim Ändern gehen nur geänderte Felder an das BFF. */
export function JobForm({ job, targets, skills, locked, busy, label, onSubmit }: {
  job?: Job; targets: Target[]; skills: string[]; locked?: boolean; busy?: boolean; label: string; onSubmit: (body: JobInput) => void;
}) {
  const [name, setName] = useState(job?.name ?? "");
  const [schedule, setSchedule] = useState(job?.schedule.expr ?? job?.schedule.display ?? "");
  const [prompt, setPrompt] = useState(job?.prompt ?? "");
  const [deliver, setDeliver] = useState(job?.deliver ?? "local");
  const [picked, setPicked] = useState<string[]>(job?.skills ?? []);
  const [unlimited, setUnlimited] = useState(job ? job.repeat.times == null : true);
  const [times, setTimes] = useState(String(job?.repeat.times ?? 1));
  const n = Number(times);
  const timesBad = !unlimited && (!Number.isInteger(n) || n < 1 || n > 1_000_000);
  const options = [...new Set([...skills, ...(job?.skills ?? [])])].sort();
  const deliverIds = targets.map((t) => t.id);
  const skillsChanged = job ? [...picked].sort().join("\n") !== [...job.skills].sort().join("\n") : picked.length > 0;
  const repeatChanged = job ? (unlimited ? job.repeat.times != null : job.repeat.times !== n) : !unlimited;

  const body = (): JobInput => {
    const b: JobInput = {};
    if (!job || name !== job.name) { if (name.trim() || job) b.name = name.trim(); }
    if (!job || schedule.trim() !== (job.schedule.expr ?? job.schedule.display ?? "")) b.schedule = schedule.trim();
    if (!job || prompt !== job.prompt) b.prompt = prompt;
    if (!job || deliver !== job.deliver) b.deliver = deliver;
    if (skillsChanged) b.skills = picked;
    if (repeatChanged) { if (unlimited) { if (job) b.repeat_unlimited = true; } else b.repeat = n; }
    return b;
  };
  const changed = Object.keys(body()).length > 0;
  const valid = schedule.trim() !== "" && (!!job || prompt.trim() !== "") && !timesBad;
  const submit = (e: FormEvent) => { e.preventDefault(); onSubmit(body()); };
  return (
    <form className="col" style={{ gap: 10 }} onSubmit={submit}>
      <fieldset disabled={locked || busy} className="jobs-fields">
        <label className="col"><span className="lbl">Name</span>
          <input className="field field-line" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} /></label>
        <label className="col"><span className="lbl">Zeitplan</span>
          <input className="field field-line mono" value={schedule} maxLength={200} onChange={(e) => setSchedule(e.target.value)} aria-describedby="jobs-sched-help" spellCheck={false} /></label>
        <p className="hint" id="jobs-sched-help" style={{ margin: 0 }}>{SCHEDULE_HELP}</p>
        <SchedulePreview value={schedule} />
        <label className="col"><span className="lbl">Prompt</span>
          <textarea className="field" rows={7} value={prompt} maxLength={20000} onChange={(e) => setPrompt(e.target.value)} />
          {job?.no_agent && <span className="hint">Dieser Job läuft ohne Agent als Skript; der Prompt wird nicht verwendet.</span>}</label>
        <fieldset className="jobs-skills"><legend className="lbl">Skills</legend>
          {options.length === 0 ? <span className="hint">Dieses Profil hat keine auswählbaren Skills.</span> : options.map((s) => (
            <label key={s} className="row" style={{ gap: 6 }}>
              <input type="checkbox" checked={picked.includes(s)} onChange={(e) => setPicked(e.target.checked ? [...picked, s] : picked.filter((x) => x !== s))} />
              <span className="mono small">{s}</span>
            </label>))}
        </fieldset>
        <label className="col"><span className="lbl">Zustellung</span>
          <select className="field field-line" value={deliver} onChange={(e) => setDeliver(e.target.value)}>
            {!deliverIds.includes(deliver) && <option value={deliver}>{deliver} (nicht mehr eingerichtet)</option>}
            {targets.map((t) => <option key={t.id} value={t.id}>{t.name}{t.ready ? "" : " (ohne Zielkanal)"}</option>)}
          </select></label>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} /><span>Unbegrenzt wiederholen</span></label>
          {!unlimited && <label className="row" style={{ gap: 6 }}><span className="lbl">Wiederholungen</span>
            <input className="field field-line" type="number" min={1} max={1000000} style={{ width: 120 }} value={times} onChange={(e) => setTimes(e.target.value)} aria-invalid={timesBad} /></label>}
        </div>
        {timesBad && <p className="hint error" role="alert" style={{ margin: 0 }}>Wiederholungen: ganze Zahl von 1 bis 1.000.000.</p>}
      </fieldset>
      <div><button type="submit" className="btn btn-s btn-p" disabled={locked || busy || !valid || !changed}>{busy ? "Speichere…" : label}</button></div>
    </form>
  );
}
