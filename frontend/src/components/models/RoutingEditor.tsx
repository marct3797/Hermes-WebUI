import { useEffect, useState } from "react";
import { api } from "../../api";
import { Icon } from "../Icon";
import { useAction } from "../useAction";
import { t } from "../../i18n";
import type { AgentRef, ProviderRouting } from "../../types";

const SLUG = /^[a-z0-9][a-z0-9._/-]{0,63}$/;
const EMPTY: ProviderRouting = { sort: "price", only: [], ignore: [], order: [], require_parameters: false, data_collection: null };
type Text = { only: string; ignore: string; order: string };

const toText = (r: ProviderRouting): Text => ({ only: r.only.join(", "), ignore: r.ignore.join(", "), order: r.order.join(", ") });
const parse = (s: string) => s.split(/[\s,]+/).filter(Boolean);

/** Anbieter-Routing für OpenRouter (`provider_routing`): wirkt nur dort. Je Modell gesetzte Ausnahmen (`models`) bleiben unberührt. */
export function RoutingEditor({ agent }: { agent: AgentRef }) {
  const [saved, setSaved] = useState<ProviderRouting>();
  const [routing, setRouting] = useState<ProviderRouting>(EMPTY);
  const [text, setText] = useState<Text>(toText(EMPTY));
  const [perModel, setPerModel] = useState<string[]>([]);
  const [loadErr, setLoadErr] = useState("");
  const { run, notes, busy } = useAction();

  useEffect(() => {
    let stop = false;
    api.providerRouting(agent).then((r) => {
      if (stop) return;
      setSaved(r.routing); setRouting(r.routing); setText(toText(r.routing)); setPerModel(r.per_model);
    }, (e: Error) => { if (!stop) setLoadErr(e.message); });
    return () => { stop = true; };
  }, [agent.host, agent.runtime, agent.agent]);

  if (loadErr) return <p className="banner" role="alert"><Icon name="alert" />{loadErr}</p>;
  if (!saved) return <p className="muted">{t("Lade…")}</p>;

  const lists = { only: parse(text.only), ignore: parse(text.ignore), order: parse(text.order) };
  const current: ProviderRouting = { ...routing, ...lists };
  const invalid = (["only", "ignore", "order"] as const).filter((k) => lists[k].some((v) => !SLUG.test(v)) || new Set(lists[k]).size !== lists[k].length);
  const dirty = JSON.stringify(current) !== JSON.stringify(saved);
  const field = (k: keyof Text, label: string) => (
    <label>{label}
      <input className="field" value={text[k]} onChange={(ev) => setText({ ...text, [k]: ev.target.value })} aria-label={label} aria-invalid={invalid.includes(k)} placeholder="anthropic, google-vertex" />
    </label>
  );
  const save = () => run(async () => {
    const r = await api.saveProviderRouting(agent, current);
    setSaved(r.routing); setRouting(r.routing); setText(toText(r.routing)); setPerModel(r.per_model);
  });
  return (
    <div>
      <p className="muted small">{t("Steuert, welche Anbieter hinter OpenRouter deine Anfragen bearbeiten. Wirkt nur bei OpenRouter, nicht bei direkten Anbieter-Verbindungen.")}</p>
      <label>{t("Sortierung")}
        <select className="field" value={routing.sort} onChange={(ev) => setRouting({ ...routing, sort: ev.target.value as ProviderRouting["sort"] })} aria-label={t("Sortierung")}>
          <option value="price">{t("Preis (günstigster zuerst)")}</option>
          <option value="throughput">{t("Durchsatz (schnellster zuerst)")}</option>
          <option value="latency">{t("Latenz (kürzeste Wartezeit zuerst)")}</option>
        </select>
      </label>
      {field("only", t("Nur diese Anbieter"))}
      {field("ignore", t("Diese Anbieter nie nutzen"))}
      {field("order", t("Feste Reihenfolge"))}
      <label className="row">
        <input type="checkbox" checked={routing.require_parameters} onChange={(ev) => setRouting({ ...routing, require_parameters: ev.target.checked })} />
        {t("Nur Anbieter, die alle Parameter unterstützen")}
      </label>
      <label>{t("Datenspeicherung")}
        <select className="field" value={routing.data_collection ?? ""} onChange={(ev) => setRouting({ ...routing, data_collection: (ev.target.value || null) as ProviderRouting["data_collection"] })} aria-label={t("Datenspeicherung")}>
          <option value="">{t("Nicht festgelegt")}</option>
          <option value="allow">{t("Erlauben")}</option>
          <option value="deny">{t("Anbieter ausschließen, die Daten speichern")}</option>
        </select>
      </label>
      {invalid.length > 0 && <p className="banner" role="alert">{t("Anbieter-Kennungen: nur Kleinbuchstaben, Ziffern, Punkt, Bindestrich und Schrägstrich, ohne Doppelte, getrennt durch Komma.")}</p>}
      {perModel.length > 0 && <p className="muted small">{t("Ausnahmen je Modell in der Konfiguration bleiben unverändert: {list}", { list: perModel.join(", ") })}</p>}
      {notes}
      <div className="row">
        <button type="button" className="btn primary" disabled={busy || !dirty || invalid.length > 0} onClick={() => void save()}>{t("Routing speichern")}</button>
      </div>
    </div>
  );
}
