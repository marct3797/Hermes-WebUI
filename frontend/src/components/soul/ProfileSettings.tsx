import { useMemo, useState } from "react";
import { api } from "../../api";
import { parseModelOptions } from "../../models";
import type { AgentRef, DashboardProfile } from "../../types";
import { useAsync } from "../../useAsync";
import { Icon } from "../Icon";
import { t } from "../../i18n";

/** Beschreibung (Rolle des Agents, auch Hinweis für die Aufgabenverteilung) und Standardmodell des Profils. */
export function ProfileSettings({ agent, profile }: { agent: AgentRef; profile: DashboardProfile }) {
  const [description, setDescription] = useState(profile.description);
  const [savedDescription, setSavedDescription] = useState(profile.description);
  const [provider, setProvider] = useState(profile.provider ?? "");
  const [model, setModel] = useState(profile.model ?? "");
  const [savedModel, setSavedModel] = useState({ provider: profile.provider ?? "", model: profile.model ?? "" });
  const [busy, setBusy] = useState<"description" | "model">();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();

  const options = useAsync(async () => parseModelOptions(await api.models(agent)), [agent.host, agent.runtime, agent.agent]);
  const groups = options.data?.groups ?? [];
  const models = useMemo(() => {
    const list = groups.find((g) => g.provider === provider)?.models ?? [];
    return model && !list.includes(model) ? [model, ...list] : list; // das eingestellte Modell bleibt wählbar, auch wenn die Liste es nicht kennt
  }, [groups, provider, model]);

  const run = async (what: "description" | "model", job: () => Promise<void>, message: string) => {
    setBusy(what); setError(undefined); setDone(undefined);
    try { await job(); setDone(message); } catch (e) { setError((e as Error).message); } finally { setBusy(undefined); }
  };

  const modelDirty = provider !== savedModel.provider || model !== savedModel.model;
  return (
    <section className="card soul-side" aria-label={t("Profil")}>
      <span className="lbl">{t("Profil im Dashboard")}</span>
      <div className="pf-fld">
        <label htmlFor="sp-desc">{t("Beschreibung")}</label>
        <textarea id="sp-desc" className="pf-in soul-desc" rows={3} maxLength={500} value={description} placeholder={t("Wofür ist dieser Agent zuständig?")}
          onChange={(e) => { setDescription(e.target.value); setDone(undefined); }} />
        <button type="button" className="btn btn-s" style={{ alignSelf: "flex-start" }} disabled={busy !== undefined || description.trim() === savedDescription}
          onClick={() => void run("description", async () => { const r = await api.saveDescription(agent, description); setSavedDescription(r.description); setDescription(r.description); }, "Beschreibung gespeichert.")}>
          <Icon name="check" size={14} />{t("Beschreibung speichern")}
        </button>
      </div>

      <div className="pf-fld">
        <label htmlFor="sp-provider">{t("Anbieter")}</label>
        <select id="sp-provider" className="pf-in" value={provider} onChange={(e) => { setProvider(e.target.value); setModel(groups.find((g) => g.provider === e.target.value)?.models[0] ?? ""); setDone(undefined); }}>
          {provider && !groups.some((g) => g.provider === provider) && <option value={provider}>{provider}</option>}
          {groups.map((g) => <option key={g.provider} value={g.provider}>{g.label}</option>)}
        </select>
      </div>
      <div className="pf-fld">
        <label htmlFor="sp-model">{t("Standardmodell")}</label>
        <select id="sp-model" className="pf-in" value={model} onChange={(e) => { setModel(e.target.value); setDone(undefined); }}>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <button type="button" className="btn btn-s" style={{ alignSelf: "flex-start" }} disabled={busy !== undefined || !modelDirty || !provider || !model}
          onClick={() => void run("model", async () => { await api.saveModel(agent, provider, model); setSavedModel({ provider, model }); }, "Modell gespeichert.")}>
          <Icon name="check" size={14} />{t("Modell speichern")}
        </button>
        <span className="hint">{t("Gilt für neue Sessions. Läuft gerade ein Chat, behält er sein Modell.")}</span>
      </div>
      {options.error && <p className="hint">{t("Modellliste nicht ladbar: {error}", { error: options.error })}</p>}

      <dl className="soul-facts mono small">
        <div><dt>{t("Skills")}</dt><dd>{profile.skill_count}</dd></div>
        <div><dt>{t("Keys")}</dt><dd>{profile.has_env ? "hinterlegt" : t("keine")}</dd></div>
      </dl>
      {error && <p className="banner" role="alert"><Icon name="alert" /><span>{error}</span></p>}
      {done && <p className="hint crimt" role="status" style={{ margin: 0 }}>{done}</p>}
    </section>
  );
}
