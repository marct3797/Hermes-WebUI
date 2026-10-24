import { useState } from "react";
import { cronApi, type Blueprint, type Job, type JobInput, type Target } from "../../opsApi";
import { useAsync } from "../../useAsync";
import { Icon } from "../Icon";
import { ErrBanner } from "./ErrBanner";
import { JobForm } from "./JobForm";

const HINT = "Neue Zeitpläne starten pausiert und laufen erst, wenn du sie bewusst aktivierst.";

export function NewJob({ host, profile, targets, skills, onCreated, onClose }: { host: string; profile: string; targets: Target[]; skills: string[]; onCreated: (j: Job) => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const create = async (body: JobInput) => {
    setBusy(true); setErr(undefined);
    try { onCreated(await cronApi.create(host, profile, body)); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <section className="card jobs-panel" aria-label="Neuer Zeitplan">
      <div className="row" style={{ gap: 8 }}><h2 className="grow" style={{ margin: 0 }}>Neuer Zeitplan</h2><button type="button" className="btn btn-s" onClick={onClose} aria-label="Schließen"><Icon name="x" size={14} /></button></div>
      <p className="hint" style={{ margin: 0 }}>{HINT}</p>
      <ErrBanner err={err} />
      <JobForm targets={targets} skills={skills} busy={busy} label="Pausiert anlegen" onSubmit={(b) => void create(b)} />
    </section>
  );
}

function Fill({ bp, onSubmit, busy }: { bp: Blueprint; onSubmit: (v: Record<string, string>) => void; busy: boolean }) {
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(bp.fields.map((f) => [f.name, f.default])));
  const ok = bp.fields.every((f) => f.optional || (vals[f.name] ?? "").trim() !== "");
  return (
    <form className="col" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); onSubmit(vals); }}>
      {bp.fields.map((f) => (
        <label key={f.name} className="col"><span className="lbl">{f.label}</span>
          {f.options.length > 0 ? (
            <select className="field field-line" value={vals[f.name]} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })}>
              {[...new Set([vals[f.name], ...f.options])].map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : <input className="field field-line" value={vals[f.name]} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })} />}
          {f.help && <span className="hint">{f.help}</span>}
        </label>))}
      <div><button type="submit" className="btn btn-s btn-p" disabled={!ok || busy}>{busy ? "Lege an…" : "Pausiert anlegen"}</button></div>
    </form>
  );
}

export function Blueprints({ host, profile, onCreated, onClose }: { host: string; profile: string; onCreated: (j: Job) => void; onClose: () => void }) {
  const list = useAsync(() => cronApi.blueprints(host, profile), [host, profile]);
  const [chosen, setChosen] = useState<Blueprint>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const go = async (values: Record<string, string>) => {
    setBusy(true); setErr(undefined);
    try { onCreated(await cronApi.instantiate(host, profile, chosen!.key, values)); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <section className="card jobs-panel" aria-label="Zeitplan aus Vorlage">
      <div className="row" style={{ gap: 8 }}><h2 className="grow" style={{ margin: 0 }}>Aus Vorlage</h2><button type="button" className="btn btn-s" onClick={onClose} aria-label="Schließen"><Icon name="x" size={14} /></button></div>
      <p className="hint" style={{ margin: 0 }}>{HINT}</p>
      {list.loading && <p className="muted small">Lade…</p>}
      {list.error && <p className="banner" role="alert"><Icon name="alert" /><span>Vorlagen nicht ladbar: {list.error}</span></p>}
      {list.data && list.data.blueprints.length === 0 && <p className="panel-empty">Dieses Profil bietet keine Vorlagen an.</p>}
      {!chosen && list.data && <ul className="kn-hits">{list.data.blueprints.map((b) => (
        <li key={b.key} className="card kn-hit"><button type="button" className="linkish" style={{ textAlign: "left" }} onClick={() => setChosen(b)}><b>{b.title}</b></button>
          <span className="small">{b.description}</span>{b.schedule_human && <span className="hint">{b.schedule_human}</span>}</li>))}</ul>}
      {chosen && <>
        <div className="row" style={{ gap: 8 }}><b className="grow">{chosen.title}</b><button type="button" className="btn btn-s" onClick={() => setChosen(undefined)}>Andere Vorlage</button></div>
        <ErrBanner err={err} />
        <Fill bp={chosen} onSubmit={(v) => void go(v)} busy={busy} />
      </>}
    </section>
  );
}
