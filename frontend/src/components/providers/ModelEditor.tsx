import { useMemo, useState } from "react";
import { ApiError, api } from "../../api";
import type { AgentRef, MatrixProfile } from "../../types";
import { useAsync } from "../../useAsync";
import { Icon } from "../Icon";
import { StepUpNote } from "./StepUpNote";
import { t } from "../../i18n";

type Props = { agent: AgentRef; profile: MatrixProfile; onSaved: (message: string) => void; onClose: () => void };

/** Anbieter und Standardmodell eines Profils. Die Liste kommt aus dem Dashboard der Maschine, angemeldete Anbieter stehen vorn. */
export function ModelEditor({ agent, profile, onSaved, onClose }: Props) {
  const options = useAsync(() => api.profileModels(agent), [agent.host, agent.runtime, agent.agent]);
  const providers = options.data?.providers ?? [];
  const [provider, setProvider] = useState(profile.provider ?? "");
  const [model, setModel] = useState(profile.model ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [stepUp, setStepUp] = useState(false);

  const models = useMemo(() => {
    const list = providers.find((p) => p.slug === provider)?.models ?? [];
    return model && !list.includes(model) ? [model, ...list] : list; // das eingestellte Modell bleibt wählbar, auch wenn die Liste es nicht kennt
  }, [providers, provider, model]);
  const chosen = providers.find((p) => p.slug === provider);
  const dirty = provider !== (profile.provider ?? "") || model !== (profile.model ?? "");

  const save = async () => {
    setBusy(true); setError(undefined); setStepUp(false);
    try {
      await api.saveModel(agent, provider, model);
      onSaved(t("Modell von {name} gespeichert: {provider} · {model}. Gilt für neue Sessions.", { name: profile.name, provider, model }));
    } catch (e) {
      if (e instanceof ApiError && e.code === "step_up_required") setStepUp(true);
      else setError((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <form className="prov-form" aria-label={`Modell von ${profile.name}`} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {options.loading && <p className="muted small">{t("Lade Anbieter…")}</p>}
      {options.error && <p className="banner" role="alert"><Icon name="alert" /><span>{t("Modellliste nicht ladbar: {error}", { error: options.error })}</span></p>}
      <div className="pf-fld">
        <label htmlFor={`me-p-${profile.name}`}>{t("Anbieter")}</label>
        <select id={`me-p-${profile.name}`} className="pf-in" value={provider}
          onChange={(e) => { setProvider(e.target.value); setModel(providers.find((p) => p.slug === e.target.value)?.models[0] ?? ""); }}>
          {provider && !providers.some((p) => p.slug === provider) && <option value={provider}>{provider}</option>}
          {providers.map((p) => <option key={p.slug} value={p.slug}>{p.name}{p.authenticated ? "" : t(" (nicht angemeldet)")}</option>)}
        </select>
        {chosen && !chosen.authenticated && <span className="hint">{t("Für diesen Anbieter ist in diesem Profil noch kein Zugang eingerichtet.")}</span>}
        {chosen?.warning && <span className="hint">{chosen.warning}</span>}
      </div>
      <div className="pf-fld">
        <label htmlFor={`me-m-${profile.name}`}>{t("Standardmodell")}</label>
        <select id={`me-m-${profile.name}`} className="pf-in" value={model} onChange={(e) => setModel(e.target.value)}>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      {stepUp && <StepUpNote what={t("Das Ändern des Modells")} />}
      {error && <p className="banner" role="alert"><Icon name="alert" /><span>{error}</span></p>}
      <div className="row" style={{ gap: 8 }}>
        <button type="submit" className="btn btn-p btn-s" disabled={busy || !dirty || !provider || !model}><Icon name="check" size={14} />{t("Modell speichern")}</button>
        <button type="button" className="btn btn-s btn-g" onClick={onClose}>{t("Schließen")}</button>
      </div>
    </form>
  );
}
