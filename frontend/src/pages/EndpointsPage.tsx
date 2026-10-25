import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { PageHead } from "../components/PageHead";
import { CredentialPool } from "../components/CredentialPool";
import { useAction } from "../components/useAction";
import type { AgentRef, EpDelegation, EpList, EpLocal, EpValidate } from "../types";
import { t } from "../i18n";

const BAD_URL = /^https?:\/\/[^@/]+(\/.*)?$/; // spiegelt die BFF-Prüfung vorab: nur http(s), keine Zugangsdaten

export default function EndpointsPage({ agent }: { agent: AgentRef }) {
  const [del, setDel] = useState<EpDelegation | null>(null);
  const [list, setList] = useState<EpList | null>(null);
  const [local, setLocal] = useState<EpLocal | null>(null);
  const [form, setForm] = useState({ name: "", base_url: "", model: "", api_key: "" });
  const [check, setCheck] = useState<EpValidate | null>(null);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [loadErr, setLoadErr] = useState("");
  const { run, notes, busy } = useAction();

  const load = useCallback(async () => {
    const [d, l, m] = await Promise.all([api.epDelegation(agent), api.epList(agent), api.epLocal(agent)]);
    setDel(d); setList(l); setLocal(m);
  }, [agent]);
  useEffect(() => { load().catch((e) => setLoadErr((e as Error).message)); }, [load]);

  const urlOk = BAD_URL.test(form.base_url.trim());
  const complete = urlOk && form.name.trim() && form.model.trim();
  const body = () => ({ name: form.name.trim(), base_url: form.base_url.trim(), model: form.model.trim(), ...(form.api_key ? { api_key: form.api_key } : {}) });

  return (
    <article>
      <PageHead title={t("Eigene Endpunkte")} sub={del ? `Delegation: ${del.configured}` : t("lädt …")} />
      {notes}
      {loadErr && <p className="banner" role="alert">{loadErr}</p>}
      <section aria-label={t("Delegation")}>
        <h2>{t("Delegation")}</h2>
        {del?.blocked_reason && <p className="banner" role="alert">{del.blocked_reason}</p>}
        <label>{t("Backend")}
          <select aria-label={t("Backend")} value={del?.configured ?? ""} disabled={busy || !del} onChange={(e) => void run(async () => { await api.epBackend(agent, e.target.value); await load(); })}>
            {(del?.backends ?? []).map((b) => <option key={b.name} value={b.name}>{b.name}{b.description ? ` – ${b.description}` : ""}</option>)}
          </select>
        </label>
        <p>{t("Routen je Modell und Profil bearbeitest du in der Hermes-CLI (sie tragen Schlüssel).")}</p>
      </section>
      <section aria-label={t("Endpunkte")}>
        <h2>{t("Endpunkte")}</h2>
        <ul>
          {(list?.endpoints ?? []).map((e) => (
            <li key={e.id}>
              <strong>{e.name}</strong> {e.base_url} ({e.model}){e.has_api_key ? t(" · Schlüssel gesetzt") : ""}{e.is_current ? t(" · aktiv") : ""}
              <button type="button" disabled={busy || e.is_current} onClick={() => void run(async () => { await api.epActivate(agent, e.id); await load(); })}>{t("Aktivieren {name}", { name: e.name })}</button>
              <input aria-label={t("ID zum Löschen {name}", { name: e.name })} placeholder={e.id} value={typed[e.id] ?? ""} onChange={(ev) => setTyped({ ...typed, [e.id]: ev.target.value })} />
              <button type="button" disabled={busy || typed[e.id] !== e.id} onClick={() => void run(async () => { await api.epDelete(agent, e.id, typed[e.id]); await load(); })}>{t("Löschen {name}", { name: e.name })}</button>
            </li>
          ))}
        </ul>
        <h3>{t("Neuer Endpunkt")}</h3>
        <label>{t("Name")} <input aria-label={t("Name")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>{t("Adresse")} <input aria-label={t("Adresse")} value={form.base_url} onChange={(e) => { setForm({ ...form, base_url: e.target.value }); setCheck(null); }} /></label>
        <label>{t("Modell")} <input aria-label={t("Endpunkt-Modell")} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} /></label>
        <label>{t("Schlüssel")} <input aria-label={t("Schlüssel")} type="password" autoComplete="off" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} /></label>
        {form.base_url && !urlOk && <p className="banner">{t("Nur http(s)-Adressen ohne Zugangsdaten in der Adresse.")}</p>}
        <button type="button" disabled={busy || !complete} onClick={() => void run(async () => setCheck(await api.epValidate(agent, body())))}>{t("Erreichbarkeit prüfen")}</button>
        {check && <p role="status">{check.ok ? `Erreichbar, Modelle: ${check.models.join(", ") || t("keine gemeldet")}` : check.message}</p>}
        <button type="button" disabled={busy || !complete} onClick={() => void run(async () => { await api.epSave(agent, body()); setForm({ name: "", base_url: "", model: "", api_key: "" }); setCheck(null); await load(); })}>{t("Endpunkt speichern")}</button>
      </section>
      <CredentialPool agent={agent} />
      <section aria-label={t("Lokale Modelle")}>
        <h2>{t("Lokale Modelle")}</h2>
        {local && <p>{t("Server: {server_running}; installieren und laden über die Hermes-CLI.", { server_running: local.server_running ? "läuft" : "aus" })}</p>}
        <ul>{(local?.models ?? []).map((m) => <li key={m.id}>{t("{name} ({v} MB)", { name: m.name, v: (m.size_bytes / 1048576).toFixed(0) })}</li>)}</ul>
      </section>
    </article>
  );
}
