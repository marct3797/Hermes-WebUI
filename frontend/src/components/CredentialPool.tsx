import { useCallback, useEffect, useState } from "react";
import { p3, type Pool } from "../p3Api";
import type { AgentRef } from "../types";
import { useAction } from "./useAction";
import { t } from "../i18n";

const PROVIDER = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

/** Mehrere Schlüssel je Anbieter: Hermes wechselt bei Limits. Schlüssel nur schreiben, nie anzeigen (höchstens vier Zeichen). */
export function CredentialPool({ agent }: { agent: AgentRef }) {
  const [pool, setPool] = useState<Pool | null>(null);
  const [form, setForm] = useState({ provider: "", api_key: "", label: "" });
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [loadErr, setLoadErr] = useState("");
  const { run, notes, busy } = useAction();
  const load = useCallback(async () => setPool(await p3.poolList(agent)), [agent]);
  useEffect(() => { load().catch((e) => setLoadErr((e as Error).message)); }, [load]);
  const provider = form.provider.trim().toLowerCase();
  const ok = PROVIDER.test(provider) && form.api_key.length >= 8;

  return (
    <section aria-label={t("Schlüssel-Pools")}>
      <h2>{t("Schlüssel-Pools")}</h2>
      {notes}
      {loadErr && <p className="banner" role="alert">{loadErr}</p>}
      {pool && pool.providers.length === 0 && <p>{t("Noch keine Pools. Mehrere Schlüssel je Anbieter lassen Hermes bei Limits wechseln.")}</p>}
      {(pool?.providers ?? []).map((p) => (
        <div key={p.provider}>
          <h3>{p.provider}</h3>
          <ul>{p.entries.map((e) => (
            <li key={`${p.provider}:${e.index}`}>{t("{label} ({source}){token_tail}, {request_count} Anfragen", { label: e.label, source: e.source, token_tail: e.token_tail ? ` …${e.token_tail}` : "", request_count: e.request_count })}{e.source === "manual"
                ? <>
                    <input aria-label={`Anbieter zum Entfernen ${p.provider} ${e.index}`} placeholder={p.provider} value={typed[`${p.provider}:${e.index}`] ?? ""} onChange={(ev) => setTyped({ ...typed, [`${p.provider}:${e.index}`]: ev.target.value })} />
                    <button type="button" disabled={busy || typed[`${p.provider}:${e.index}`] !== p.provider} onClick={() => void run(async () => { await p3.poolRemove(agent, p.provider, e.index); await load(); })}>{t("Entfernen {provider} {index}", { provider: p.provider, index: e.index })}</button>
                  </>
                : <span> {t("(nur über die Hermes-CLI entfernbar)")}</span>}
            </li>))}</ul>
        </div>))}
      <h3>{t("Schlüssel hinzufügen")}</h3>
      <label>{t("Anbieter des Schlüssels")} <input aria-label={t("Pool-Anbieter")} value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} /></label>
      <label>{t("Neuer API-Schlüssel")} <input aria-label={t("Pool-Schlüssel")} type="password" autoComplete="off" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} /></label>
      <label>{t("Bezeichnung")} <input aria-label={t("Pool-Bezeichnung")} maxLength={60} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></label>
      <button type="button" disabled={busy || !ok} onClick={() => void run(async () => { await p3.poolAdd(agent, { provider, api_key: form.api_key, ...(form.label ? { label: form.label } : {}) }); setForm({ provider: "", api_key: "", label: "" }); await load(); })}>{t("Zum Pool hinzufügen")}</button>
    </section>
  );
}
