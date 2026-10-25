import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { PageHead } from "../components/PageHead";
import { useAction } from "../components/useAction";
import type { AgentRef, MdAuxiliary, MdInfo, MdMoa, MdOptions } from "../types";
import { t as tr } from "../i18n";

export default function ModelsPage({ agent }: { agent: AgentRef }) {
  const [info, setInfo] = useState<MdInfo | null>(null);
  const [opts, setOpts] = useState<MdOptions | null>(null);
  const [aux, setAux] = useState<MdAuxiliary | null>(null);
  const [moa, setMoa] = useState<MdMoa | null>(null);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [confirmMsg, setConfirmMsg] = useState("");
  const [loadErr, setLoadErr] = useState("");
  const { run, notes, busy } = useAction();

  const load = useCallback(async () => {
    const [i, o, a, m] = await Promise.all([api.mdInfo(agent), api.mdOptions(agent), api.mdAuxiliary(agent), api.mdMoa(agent)]);
    setInfo(i); setOpts(o); setAux(a); setMoa(m);
    setProvider(i.provider); setModel(i.model);
  }, [agent]);
  useEffect(() => { load().catch((e) => setLoadErr((e as Error).message)); }, [load]);

  const known = new Set<string>((opts?.providers ?? []).flatMap((p) => p.models));
  const save = () => run(async () => {
    const r = await api.mdSet(agent, { scope: "main", provider, model });
    if (r.confirm_required) { setConfirmMsg(r.confirm_message ?? tr("Teures Modell: bitte bestätigen.")); return; }
    setConfirmMsg("");
    await load();
  });
  const saveConfirmed = () => run(async () => {
    await api.mdSet(agent, { scope: "main", provider, model, confirm_expensive_model: true });
    setConfirmMsg("");
    await load();
  });

  return (
    <article>
      <PageHead title={tr("Modelle")} sub={info ? (info.configured ? `${info.provider} / ${info.model}` : tr("noch kein Modell eingestellt")) : tr("lädt …")} />
      {notes}
      {loadErr && <p className="banner" role="alert">{loadErr}</p>}
      {opts && opts.providers.length === 0 && <p className="banner" role="status">{tr("Noch kein Anbieter eingerichtet. Hinterlege zuerst unter „Anbieter“ einen Schlüssel oder melde dich an, dann erscheint hier die Modellauswahl.")}</p>}
      <section aria-label={tr("Hauptmodell")}>
        <h2>{tr("Hauptmodell")}</h2>
        {info && (info.configured
          ? <p>{tr("Aktiv:")} <strong>{info.provider} / {info.model}</strong> {tr("(Kontext:")} {info.context_window.toLocaleString("de-DE")})</p>
          : <p>{tr("Noch kein Hauptmodell eingestellt.")}</p>)}
        <label>{tr("Anbieter")} <input aria-label={tr("Anbieter")} value={provider} onChange={(e) => setProvider(e.target.value)} /></label>
        <label>{tr("Modell")} <input aria-label={tr("Modell")} value={model} onChange={(e) => setModel(e.target.value)} list="md-models" /></label>
        <datalist id="md-models">{[...known].map((m) => <option key={m} value={m} />)}</datalist>
        {!known.has(model) && model && <p className="banner">{tr("Unbekanntes Modell: bitte aus der Auswahl nehmen, nichts erfinden.")}</p>}
        <button type="button" disabled={busy || !known.has(model)} onClick={save}>{tr("Modell übernehmen")}</button>
        {confirmMsg && <><p className="banner" role="alert">{confirmMsg}</p><button type="button" disabled={busy} onClick={saveConfirmed}>{tr("Teures Modell bestätigen")}</button></>}
      </section>
      <section aria-label={tr("Auswahl")}>
        <h2>{tr("Auswahl")}</h2>
        <ul>{(opts?.providers ?? []).map((p) => <li key={p.slug}>{p.name}: {p.models.join(", ")}</li>)}</ul>
      </section>
      <section aria-label={tr("Hilfsmodelle")}>
        <h2>{tr("Hilfsmodelle")}</h2>
        <ul>{(aux?.tasks ?? []).map((t) => <li key={t.task}>{t.task}: {t.provider}{t.model ? ` / ${t.model}` : ""}</li>)}</ul>
      </section>
      <section aria-label={tr("MoA")}>
        <h2>{tr("MoA")}</h2>
        {moa && <p>{tr("Aktives Preset:")} <strong>{moa.active_preset}</strong> ({Object.keys(moa.presets).join(", ")})</p>}
      </section>
    </article>
  );
}
