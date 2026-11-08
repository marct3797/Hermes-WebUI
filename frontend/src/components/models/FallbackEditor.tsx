import { useEffect, useState } from "react";
import { api } from "../../api";
import { Icon } from "../Icon";
import { useAction } from "../useAction";
import { t } from "../../i18n";
import type { AgentRef, MdOptions } from "../../types";

type Entry = { provider: string; model: string };
const MAX = 10;

/** Ersatz-Anbieter in Reihenfolge (`fallback_providers`) und Mindest-Wartezeit (`fallback.min_switch_reset_seconds`): läuft über die Einstellungen des Profils. */
export function FallbackEditor({ agent, opts }: { agent: AgentRef; opts: MdOptions | null }) {
  const [entries, setEntries] = useState<Entry[]>();
  const [saved, setSaved] = useState("");
  const [minReset, setMinReset] = useState("0");
  const [savedMin, setSavedMin] = useState("0");
  const [hasMin, setHasMin] = useState(false);
  const [missing, setMissing] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const { run, notes, busy } = useAction();

  useEffect(() => {
    let stop = false;
    api.hermesConfig(agent).then((c) => {
      if (stop) return;
      const list = c.fields.find((f) => f.key === "fallback_providers");
      const min = c.fields.find((f) => f.key === "fallback.min_switch_reset_seconds");
      setMissing(!list); setHasMin(!!min);
      const rows = Array.isArray(list?.value) ? (list!.value as unknown[]).filter((e): e is Entry => !!e && typeof (e as Entry).provider === "string" && typeof (e as Entry).model === "string") : [];
      setEntries(rows.map((e) => ({ provider: e.provider, model: e.model })));
      setSaved(JSON.stringify(rows.map((e) => ({ provider: e.provider, model: e.model }))));
      const m = String(typeof min?.value === "number" ? min.value : 0);
      setMinReset(m); setSavedMin(m);
    }, (e: Error) => { if (!stop) setLoadErr(e.message); });
    return () => { stop = true; };
  }, [agent.host, agent.runtime, agent.agent]);

  if (loadErr) return <p className="banner" role="alert"><Icon name="alert" />{loadErr}</p>;
  if (!entries) return <p className="muted">{t("Lade…")}</p>;
  if (missing) return <p className="muted small">{t("Dieses Hermes kennt keine Ersatz-Anbieter.")}</p>;

  const providers = opts?.providers ?? [];
  const patch = (i: number, p: Partial<Entry>) => setEntries(entries.map((e, k) => (k === i ? { ...e, ...p } : e)));
  const move = (i: number, d: number) => { const next = [...entries]; [next[i], next[i + d]] = [next[i + d], next[i]]; setEntries(next); };
  const seconds = Number(minReset);
  const dup = new Set(entries.map((e) => `${e.provider}/${e.model}`)).size !== entries.length;
  const bad = entries.some((e) => !e.provider.trim() || !e.model.trim()) || dup || (hasMin && (!Number.isInteger(seconds) || seconds < 0));
  const dirty = JSON.stringify(entries) !== saved || minReset !== savedMin;
  const save = () => run(async () => {
    const clean = entries.map((e) => ({ provider: e.provider.trim(), model: e.model.trim() }));
    await api.saveHermesConfig(agent, hasMin ? { fallback_providers: clean, "fallback.min_switch_reset_seconds": seconds } : { fallback_providers: clean });
    setEntries(clean); setSaved(JSON.stringify(clean)); setMinReset(String(seconds)); setSavedMin(String(seconds));
  });
  return (
    <div>
      <p className="muted small">{t("Fällt der Hauptanbieter aus (Limit, Überlast, Anmeldung), wechselt Hermes nacheinander zu diesen Anbietern. Reihenfolge von oben nach unten.")}</p>
      {entries.length === 0 && <p className="muted small">{t("Keine Ersatz-Anbieter eingetragen.")}</p>}
      <ol className="ext-list">
        {entries.map((e, i) => {
          const info = providers.find((p) => p.slug === e.provider);
          return (
            <li key={i} className="card ext-detail">
              <label>{t("Anbieter")}
                <select className="field" value={e.provider} onChange={(ev) => patch(i, { provider: ev.target.value, model: "" })} aria-label={t("Anbieter {n}", { n: i + 1 })}>
                  {!info && <option value={e.provider}>{e.provider || "–"}</option>}
                  {providers.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
                </select>
              </label>
              <label>{t("Modell")}
                <input className="field" value={e.model} list={`fb-models-${i}`} onChange={(ev) => patch(i, { model: ev.target.value })} aria-label={t("Modell {n}", { n: i + 1 })} />
                <datalist id={`fb-models-${i}`}>{(info?.models ?? []).map((m) => <option key={m} value={m} />)}</datalist>
              </label>
              {info && info.authenticated === false && <p className="muted small">{t("Für diesen Anbieter ist noch kein Zugang eingerichtet.")}</p>}
              <div className="row">
                <button type="button" className="btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t("Nach oben: {n}", { n: i + 1 })}>↑</button>
                <button type="button" className="btn" disabled={i === entries.length - 1} onClick={() => move(i, 1)} aria-label={t("Nach unten: {n}", { n: i + 1 })}>↓</button>
                <button type="button" className="btn" onClick={() => setEntries(entries.filter((_, k) => k !== i))} aria-label={t("Entfernen: {n}", { n: i + 1 })}>{t("Entfernen")}</button>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="row">
        <button type="button" className="btn" disabled={entries.length >= MAX} onClick={() => setEntries([...entries, { provider: providers[0]?.slug ?? "", model: "" }])}>{t("Ersatz-Anbieter hinzufügen")}</button>
      </div>
      {hasMin && <label>{t("Nicht wechseln, wenn das Limit in weniger als so vielen Sekunden endet (0 = immer wechseln)")}
        <input className="field" inputMode="numeric" value={minReset} onChange={(ev) => setMinReset(ev.target.value)} aria-label={t("Mindest-Wartezeit in Sekunden")} />
      </label>}
      {dup && <p className="banner" role="alert">{t("Derselbe Anbieter mit demselben Modell steht doppelt in der Liste.")}</p>}
      {notes}
      <div className="row">
        <button type="button" className="btn primary" disabled={busy || bad || !dirty} onClick={() => void save()}>{t("Speichern")}</button>
      </div>
    </div>
  );
}
