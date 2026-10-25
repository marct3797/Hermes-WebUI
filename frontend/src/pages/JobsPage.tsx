import { useMemo, useState } from "react";
import { Blueprints, NewJob } from "../components/jobs/NewJob";
import { JobPanel, statusOf } from "../components/jobs/JobPanel";
import { stamp } from "../components/jobs/JobForm";
import { Icon } from "../components/Icon";
import { PageHead } from "../components/PageHead";
import { useHosts } from "../hosts";
import { cronApi, type Job } from "../opsApi";
import { useAsync } from "../useAsync";
import { N_, t } from "../i18n";

type Side = { kind: "job"; id: string } | { kind: "new" } | { kind: "blueprints" } | undefined;
const FILTERS = [["all", N_("Alle")], ["active", N_("Aktiv")], ["paused", N_("Pausiert")], ["error", N_("Fehler")]] as const;

function Row({ job, on, onClick }: { job: Job; on: boolean; onClick: () => void }) {
  const st = statusOf(job);
  return (
    <li>
      <button type="button" className={`card jobs-row${on ? " on" : ""}`} aria-pressed={on} onClick={onClick}>
        <span className="row" style={{ gap: 8 }}><b className="grow trunc">{job.name || job.id}</b><span className={`tag jobs-st-${st.key}`}>{st.label}</span></span>
        <span className="mono small">{job.schedule.display ?? t("Zeitplan unbekannt")}{job.system ? t(" · System-Job") : ""}</span>
        <span className="small t3">{t("Nächster Lauf: {next_run_at} · Letzter Lauf: {last_run_at}{last_status}", { next_run_at: stamp(job.next_run_at), last_run_at: stamp(job.last_run_at), last_status: job.last_status ? ` · ${job.last_status === "ok" ? "erfolgreich" : job.last_status}` : "" })}</span>
        {job.last_error && <span className="small error trunc">{job.last_error}</span>}
      </button>
    </li>
  );
}

/** Zeitpläne (Cron) eines Hosts und Profils über das Dashboard: ansehen, anlegen, bearbeiten, aktivieren, ausführen, löschen. */
export function JobsPage({ host }: { host?: string }) {
  const registry = useHosts();
  const [chosenHost, setChosenHost] = useState<string>();
  const [chosenProfile, setChosenProfile] = useState<string>();
  const [side, setSide] = useState<Side>();
  const [rev, setRev] = useState(0);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all");
  const hostId = host ?? chosenHost ?? registry.hosts?.[0]?.id;
  const known = registry.hosts?.find((h) => h.id === hostId);
  const profiles = known?.runtimes.find((r) => r.id === "hermes")?.agents ?? known?.runtimes[0]?.agents ?? [];
  const profile = profiles.find((p) => p.id === chosenProfile)?.id ?? profiles[0]?.id;
  const ready = !!hostId && !!profile;
  const jobs = useAsync(() => (ready ? cronApi.list(hostId, profile) : Promise.resolve(undefined)), [hostId, profile, rev]);
  const targets = useAsync(() => (ready ? cronApi.targets(hostId, profile) : Promise.resolve(undefined)), [hostId, profile]);
  const skills = useAsync(() => (ready ? cronApi.skills(hostId, profile) : Promise.resolve(undefined)), [hostId, profile]);
  const list = jobs.data?.jobs ?? [];
  const shown = useMemo(() => list.filter((j) => (filter === "all" || statusOf(j).key === filter) && (!q.trim() || `${j.name} ${j.id} ${j.schedule.display} ${j.prompt}`.toLowerCase().includes(q.trim().toLowerCase()))), [list, q, filter]);
  const selected = side?.kind === "job" ? list.find((j) => j.id === side.id) : undefined;
  const reload = () => setRev((n) => n + 1);
  const created = (j: Job) => { setSide({ kind: "job", id: j.id }); reload(); };
  const tList = targets.data?.targets ?? [{ id: "local", name: t("Lokal (nur speichern)"), ready: true }];
  return (
    <main className="page">
      <PageHead title={t("Zeitpläne")} sub={known && profile ? `${known.label} · ${profile}` : undefined}>
        {!host && registry.hosts && registry.hosts.length > 1 && (
          <label className="row" style={{ gap: 6 }}><span className="lbl">{t("Host")}</span>
            <select className="field field-line" aria-label={t("Host")} value={hostId} onChange={(e) => { setChosenHost(e.target.value); setChosenProfile(undefined); setSide(undefined); }}>
              {registry.hosts.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}</select></label>)}
        {profiles.length > 1 && (
          <label className="row" style={{ gap: 6 }}><span className="lbl">{t("Profil")}</span>
            <select className="field field-line" aria-label={t("Profil")} value={profile} onChange={(e) => { setChosenProfile(e.target.value); setSide(undefined); }}>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.label || p.id}</option>)}</select></label>)}
      </PageHead>
      {registry.error && <p className="banner" role="alert">{registry.error}</p>}
      {!registry.hosts && !registry.error && <p className="muted" role="status">{t("Hosts werden geladen…")}</p>}
      {registry.hosts && !known && <p className="empty">{host ? t("Host nicht in der Registry vorhanden.") : t("Keine Hosts konfiguriert.")}</p>}
      {known && !profile && <p className="empty">{t("Keine Profile verfügbar. Host und Profilfreigaben prüfen.")}</p>}
      {ready && (
        <>
          <div className="row mem-bar" style={{ gap: 8, flexWrap: "wrap" }}>
            <label className="search grow"><Icon name="search" size={14} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Name, Zeitplan oder Prompt")} aria-label={t("Zeitpläne filtern")} maxLength={200} /></label>
            <div className="tabs" role="group" aria-label={t("Status filtern")}>
              {FILTERS.map(([k, label]) => <button key={k} type="button" className={`tab${filter === k ? " on" : ""}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>{t(label)}</button>)}</div>
            <button type="button" className="btn btn-s btn-p" onClick={() => setSide({ kind: "new" })}><Icon name="plus" size={14} />{t("Neuer Zeitplan")}</button>
            <button type="button" className="btn btn-s" onClick={() => setSide({ kind: "blueprints" })}>{t("Aus Vorlage")}</button>
            <button type="button" className="btn btn-s" disabled={jobs.loading} onClick={reload}><Icon name="refresh" size={14} />{t("Neu laden")}</button>
          </div>
          {jobs.error && <p className="banner" role="alert"><Icon name="alert" /><span>{t("Zeitpläne nicht ladbar: {error}", { error: jobs.error })}</span></p>}
          {(targets.error || skills.error) && <p className="banner" role="status"><Icon name="alert" /><span>{targets.error ? t("Zustellziele nicht ladbar ({error}); nur „Lokal“ wählbar. ", { error: targets.error }) : ""}{skills.error ? t("Skills nicht ladbar ({error}).", { error: skills.error }) : ""}</span></p>}
          <div className={`jobs-grid${side ? " has-side" : ""}`}>
            <section aria-label={t("Zeitplanliste")}>
              {jobs.loading && <p className="muted small" role="status">{t("Lade…")}</p>}
              {jobs.data && list.length === 0 && <p className="panel-empty">{t("Für dieses Profil gibt es noch keine Zeitpläne. Lege mit „Neuer Zeitplan“ oder „Aus Vorlage“ den ersten an.")}</p>}
              {jobs.data && list.length > 0 && shown.length === 0 && <p className="panel-empty">{t("Kein Zeitplan passt zu Suche und Filter.")}</p>}
              <ul className="kn-hits" aria-label={t("Zeitpläne")}>{shown.map((j) => <Row key={j.id} job={j} on={side?.kind === "job" && side.id === j.id} onClick={() => setSide({ kind: "job", id: j.id })} />)}</ul>
            </section>
            {side && (
              <div className="jobs-side">
                {side.kind === "new" && <NewJob host={hostId} profile={profile} targets={tList} skills={skills.data?.skills ?? []} onCreated={created} onClose={() => setSide(undefined)} />}
                {side.kind === "blueprints" && <Blueprints host={hostId} profile={profile} onCreated={created} onClose={() => setSide(undefined)} />}
                {side.kind === "job" && selected && <JobPanel key={selected.id} host={hostId} profile={profile} job={selected} targets={tList} skills={skills.data?.skills ?? []} onChanged={(deleted) => { if (deleted) setSide(undefined); reload(); }} onClose={() => setSide(undefined)} />}
                {side.kind === "job" && !selected && !jobs.loading && <p className="panel-empty">{t("Dieser Zeitplan existiert nicht mehr.")}</p>}
              </div>)}
          </div>
        </>)}
    </main>
  );
}
