import { useEffect, useState } from "react";
import { api } from "../api";
import { useAction } from "./useAction";
import type { AgentRef, DlgProfileRoute, DlgRoute, DlgRouteIn, EpDelegation } from "../types";
import { t } from "../i18n";

const EFFORT = ["", "none", "minimal", "low", "medium", "high", "xhigh"];
const TIER = ["", "normal", "fast", "ultrafast"];

type Row = DlgRouteIn & { had_key: boolean };
const toRow = (r: DlgRoute): Row => ({ name: r.name, original_name: r.name, description: r.description, provider: r.provider, model: r.model, base_url: r.base_url, reasoning_effort: r.reasoning_effort, service_tier: r.service_tier, api_key: "", clear_api_key: false, had_key: r.has_api_key });
const blank = (): Row => ({ name: "", original_name: "", description: "", provider: "", model: "", base_url: "", reasoning_effort: "", service_tier: "", api_key: "", clear_api_key: false, had_key: false });

/** Modell- und Profilrouten der Delegation. Schlüssel sind write-only; ein leeres Schlüsselfeld behält den gespeicherten. */
export function DelegationRoutes({ agent, del, onSaved }: { agent: AgentRef; del: EpDelegation; onSaved: () => Promise<void> }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [def, setDef] = useState("");
  const [pr, setPr] = useState<DlgProfileRoute[]>([]);
  const [prDef, setPrDef] = useState("");
  const [typedM, setTypedM] = useState("");
  const [typedP, setTypedP] = useState("");
  const [saved, setSaved] = useState("");
  const m = useAction();
  const p = useAction();
  useEffect(() => {
    setRows((del.model_map?.options ?? []).map(toRow)); setDef(del.model_map?.default ?? "");
    setPr(del.profile_routes?.profiles ?? []); setPrDef(del.profile_routes?.default ?? "");
  }, [del]);
  if (!del.model_map || !del.profile_routes) return null;
  const set = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const names = rows.map((r) => r.name.trim());
  const rowsOk = rows.every((r) => r.name.trim() && r.description.trim() && r.model.trim() && (r.provider.trim() || r.base_url.trim())) && new Set(names).size === names.length;
  const free = del.profiles.filter((n) => !pr.some((x) => x.name === n));

  return (
    <>
      <section aria-label={t("Modellrouten")}>
        <h3>{t("Modellrouten")}</h3>
        <p>{t("Benannte Modelle, aus denen der Agent für Unteraufgaben wählt. Schlüssel werden nie angezeigt; ein leeres Feld behält den gespeicherten.")}</p>
        {m.notes}
        {rows.map((r, i) => (
          <fieldset key={i}>
            <legend>{r.name || t("Neue Route")}</legend>
            <label>{t("Routenname")} <input aria-label={t("Routenname {n}", { n: i + 1 })} value={r.name} onChange={(e) => set(i, { name: e.target.value })} /></label>
            <label>{t("Routenbeschreibung")} <input aria-label={t("Routenbeschreibung {n}", { n: i + 1 })} value={r.description} onChange={(e) => set(i, { description: e.target.value })} /></label>
            <label>{t("Routenmodell")} <input aria-label={t("Routenmodell {n}", { n: i + 1 })} value={r.model} onChange={(e) => set(i, { model: e.target.value })} /></label>
            <label>{t("Routenanbieter")} <input aria-label={t("Routenanbieter {n}", { n: i + 1 })} value={r.provider} onChange={(e) => set(i, { provider: e.target.value })} /></label>
            <label>{t("Routenadresse")} <input aria-label={t("Routenadresse {n}", { n: i + 1 })} value={r.base_url} onChange={(e) => set(i, { base_url: e.target.value })} /></label>
            <label>{t("Denkaufwand")} <select aria-label={t("Denkaufwand {n}", { n: i + 1 })} value={r.reasoning_effort} onChange={(e) => set(i, { reasoning_effort: e.target.value })}>{EFFORT.map((x) => <option key={x} value={x}>{x || t("Standard")}</option>)}</select></label>
            <label>{t("Dienststufe")} <select aria-label={t("Dienststufe {n}", { n: i + 1 })} value={r.service_tier} onChange={(e) => set(i, { service_tier: e.target.value })}>{TIER.map((x) => <option key={x} value={x}>{x || t("Standard")}</option>)}</select></label>
            <label>{t("Routenschlüssel")} <input aria-label={t("Routenschlüssel {n}", { n: i + 1 })} type="password" autoComplete="off" placeholder={r.had_key ? t("gesetzt – leer lassen zum Behalten") : ""} value={r.api_key} onChange={(e) => set(i, { api_key: e.target.value })} /></label>
            {r.had_key && <label><input type="checkbox" checked={r.clear_api_key} onChange={(e) => { const c = e.target.checked; set(i, { clear_api_key: c }); }} /> {t("Gespeicherten Schlüssel entfernen")}</label>}
            <button type="button" onClick={() => { setRows(rows.filter((_, j) => j !== i)); if (def === r.name) setDef(""); }}>{t("Route {n} entfernen", { n: i + 1 })}</button>
          </fieldset>
        ))}
        <button type="button" disabled={rows.length >= 50} onClick={() => setRows([...rows, blank()])}>{t("Route hinzufügen")}</button>
        <label>{t("Standardroute")} <select aria-label={t("Standardroute")} value={def} onChange={(e) => setDef(e.target.value)}><option value="">{t("keine")}</option>{names.filter(Boolean).map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        <label>{t("Zum Ersetzen „{word}“ eintippen", { word: agent.agent })} <input aria-label={t("Bestätigung Modellrouten")} value={typedM} onChange={(e) => setTypedM(e.target.value)} /></label>
        <button type="button" disabled={m.busy || !rowsOk || typedM.trim() !== agent.agent} onClick={() => void m.run(async () => {
          const body = rows.map(({ had_key: _h, ...r }) => ({ ...r, name: r.name.trim(), original_name: r.original_name }));
          const r = await api.dlgModelMap(agent, { options: body, default: def, confirm: typedM.trim() });
          setRows(r.options.map(toRow)); setDef(r.default ?? ""); setTypedM(""); setSaved(t("Modellrouten gespeichert.")); await onSaved();
        })}>{t("Modellrouten speichern")}</button>
        {saved && <p role="status">{saved}</p>}
      </section>
      <section aria-label={t("Profilrouten")}>
        <h3>{t("Profilrouten")}</h3>
        <p>{t("Profile, als die Unteraufgaben laufen dürfen.")}</p>
        {p.notes}
        <ul>{pr.map((x, i) => (
          <li key={x.name}>
            <strong>{x.name}</strong>{" "}
            <input aria-label={t("Beschreibung Profil {name}", { name: x.name })} value={x.description ?? ""} onChange={(e) => setPr(pr.map((y, j) => (j === i ? { ...y, description: e.target.value } : y)))} />
            <button type="button" onClick={() => { setPr(pr.filter((_, j) => j !== i)); if (prDef === x.name) setPrDef(""); }}>{t("Profil {name} entfernen", { name: x.name })}</button>
          </li>
        ))}</ul>
        {free.length > 0 && <label>{t("Profil hinzufügen")} <select aria-label={t("Profil hinzufügen")} value="" onChange={(e) => e.target.value && setPr([...pr, { name: e.target.value, description: "" }])}><option value="">{t("wählen …")}</option>{free.map((n) => <option key={n} value={n}>{n}</option>)}</select></label>}
        <label>{t("Standardprofil")} <select aria-label={t("Standardprofil")} value={prDef} onChange={(e) => setPrDef(e.target.value)}><option value="">{t("keins")}</option>{pr.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}</select></label>
        <label>{t("Zum Ersetzen „{word}“ eintippen", { word: agent.agent })} <input aria-label={t("Bestätigung Profilrouten")} value={typedP} onChange={(e) => setTypedP(e.target.value)} /></label>
        <button type="button" disabled={p.busy || typedP.trim() !== agent.agent} onClick={() => void p.run(async () => {
          await api.dlgProfileRoutes(agent, { profiles: pr, default: prDef, confirm: typedP.trim() }); setTypedP(""); setSaved(t("Profilrouten gespeichert.")); await onSaved();
        })}>{t("Profilrouten speichern")}</button>
      </section>
    </>
  );
}
