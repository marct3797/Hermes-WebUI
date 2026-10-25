import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { PageHead } from "../components/PageHead";
import { useAction } from "../components/useAction";
import type { AcHooks, AcPairing, AgentRef } from "../types";
import { t } from "../i18n";

export default function AccessPage({ agent }: { agent: AgentRef }) {
  const [pairing, setPairing] = useState<AcPairing | null>(null);
  const [hooks, setHooks] = useState<AcHooks | null>(null);
  const [name, setName] = useState("");
  const [events, setEvents] = useState("");
  const [secret, setSecret] = useState<{ name: string; url: string; secret: string } | null>(null);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [loadErr, setLoadErr] = useState("");
  const { run, notes, busy } = useAction();

  const load = useCallback(async () => {
    const [p, h] = await Promise.all([api.acPairing(agent), api.acHooks(agent)]);
    setPairing(p); setHooks(h);
  }, [agent]);
  useEffect(() => { load().catch((e) => setLoadErr((e as Error).message)); }, [load]);

  const nameOk = /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name.trim().toLowerCase().replace(/ /g, "-"));
  const evList = events.split(",").map((e) => e.trim()).filter(Boolean);
  return (
    <article>
      <PageHead title={t("Zugang und Webhooks")} sub={pairing ? `${pairing.pending.length} offene Anfragen, ${pairing.approved.length} freigegeben` : t("lädt …")} />
      {notes}
      {loadErr && <p className="banner" role="alert">{loadErr}</p>}
      <section aria-label={t("Pairing")}>
        <h2>{t("Freigaben")}</h2>
        <h3>{t("Offene Anfragen")}</h3>
        <ul>{(pairing?.pending ?? []).map((p) => (
          <li key={p.request_id}>{t("{user_id} ({platform}, vor {age_minutes} Min.)", { user_id: p.user_name || p.user_id, platform: p.platform, age_minutes: p.age_minutes })}<button type="button" disabled={busy || !p.request_id} onClick={() => void run(async () => { setPairing(await api.acApprove(agent, p.platform, p.request_id)); })}>{t("Freigeben {user_id}", { user_id: p.user_id })}</button>
          </li>))}</ul>
        <h3>{t("Freigegeben")}</h3>
        <ul>{(pairing?.approved ?? []).map((a) => (
          <li key={`${a.platform}:${a.user_id}`}>{t("{user_id} ({platform}, ID {user_id2})", { user_id: a.user_name || a.user_id, platform: a.platform, user_id2: a.user_id })}<input aria-label={`ID zum Sperren ${a.user_id}`} placeholder={a.user_id} value={typed[`p:${a.user_id}`] ?? ""} onChange={(e) => setTyped({ ...typed, [`p:${a.user_id}`]: e.target.value })} />
            <button type="button" disabled={busy || typed[`p:${a.user_id}`] !== a.user_id} onClick={() => void run(async () => { setPairing(await api.acRevoke(agent, a.platform, a.user_id, a.user_id)); })}>{t("Sperren {user_id}", { user_id: a.user_id })}</button>
          </li>))}</ul>
      </section>
      <section aria-label={t("Webhooks")}>
        <h2>{t("Webhooks")}</h2>
        {hooks && !hooks.enabled && (
          <div>
            <p className="banner">{t("Die Webhook-Plattform ist aus. Einschalten startet das Gateway neu und unterbricht laufende Sitzungen.")}</p>
            <button type="button" disabled={busy} onClick={() => { if (window.confirm(t("Gateway neu starten und Webhooks einschalten?"))) void run(async () => { setHooks(await api.acHooksEnable(agent)); }); }}>{t("Webhooks einschalten")}</button>
          </div>
        )}
        {secret && <p role="status">{t("Secret für")} {secret.name}: <code>{secret.secret}</code> {t("(wird nur jetzt angezeigt; URL")} {secret.url}) <button type="button" onClick={() => setSecret(null)}>{t("Secret ausblenden")}</button></p>}
        <ul>{(hooks?.subscriptions ?? []).map((h) => (
          <li key={h.name}><strong>{h.name}</strong> {h.url} {h.enabled ? t("· an") : t("· aus")}
            <button type="button" disabled={busy} onClick={() => void run(async () => { await api.acHookToggle(agent, h.name, !h.enabled); await load(); })}>{h.enabled ? t("Ausschalten") : t("Einschalten")} {h.name}</button>
            <input aria-label={t("Name zum Löschen {name}", { name: h.name })} placeholder={h.name} value={typed[`h:${h.name}`] ?? ""} onChange={(e) => setTyped({ ...typed, [`h:${h.name}`]: e.target.value })} />
            <button type="button" disabled={busy || typed[`h:${h.name}`] !== h.name} onClick={() => void run(async () => { await api.acHookDelete(agent, h.name, h.name); await load(); })}>{t("Löschen {name}", { name: h.name })}</button>
          </li>))}</ul>
        {hooks?.enabled && (
          <div>
            <h3>{t("Neuer Webhook")}</h3>
            <label>{t("Name")} <input aria-label={t("Webhook-Name")} value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label>{t("Ereignisse (Komma)")} <input aria-label={t("Ereignisse")} value={events} onChange={(e) => setEvents(e.target.value)} /></label>
            <button type="button" disabled={busy || !nameOk} onClick={() => void run(async () => { const c = await api.acHookCreate(agent, { name: name.trim(), events: evList }); setSecret({ name: c.name, url: c.url, secret: c.secret }); setName(""); setEvents(""); await load(); })}>{t("Webhook anlegen")}</button>
          </div>
        )}
      </section>
    </article>
  );
}
