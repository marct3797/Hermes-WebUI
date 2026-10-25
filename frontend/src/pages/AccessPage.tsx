import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { PageHead } from "../components/PageHead";
import { StepUpNote } from "../components/providers/StepUpNote";
import type { AcHooks, AcPairing, AgentRef } from "../types";

function useAction() {
  const [error, setError] = useState<string>();
  const [stepUp, setStepUp] = useState(false);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true); setError(undefined); setStepUp(false); setMissing(false);
    try { await fn(); return true; }
    catch (e) {
      if (e instanceof ApiError && e.code === "step_up_required") setStepUp(true);
      else if (e instanceof ApiError && e.status === 501) setMissing(true);
      else setError((e as Error).message);
      return false;
    }
    finally { setBusy(false); }
  };
  const notes = <>{stepUp && <StepUpNote what="Diese Änderung" />}{missing && <p className="banner">Für diese Runtime ist kein Dashboard eingerichtet.</p>}{error && <p className="banner" role="alert">{error}</p>}</>;
  return { run, notes, busy };
}

export default function AccessPage({ agent }: { agent: AgentRef }) {
  const [pairing, setPairing] = useState<AcPairing | null>(null);
  const [hooks, setHooks] = useState<AcHooks | null>(null);
  const [name, setName] = useState("");
  const [events, setEvents] = useState("");
  const [secret, setSecret] = useState<{ name: string; url: string; secret: string } | null>(null);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const { run, notes, busy } = useAction();

  const load = useCallback(async () => {
    const [p, h] = await Promise.all([api.acPairing(agent), api.acHooks(agent)]);
    setPairing(p); setHooks(h);
  }, [agent]);
  useEffect(() => { void load().catch(() => undefined); }, [load]);

  const nameOk = /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name.trim().toLowerCase().replace(/ /g, "-"));
  const evList = events.split(",").map((e) => e.trim()).filter(Boolean);
  return (
    <article>
      <PageHead title="Zugang und Webhooks" sub={pairing ? `${pairing.pending.length} offene Anfragen, ${pairing.approved.length} freigegeben` : "lädt …"} />
      {notes}
      <section aria-label="Pairing">
        <h2>Freigaben</h2>
        <h3>Offene Anfragen</h3>
        <ul>{(pairing?.pending ?? []).map((p) => (
          <li key={p.request_id}>{p.user_name || p.user_id} ({p.platform}, vor {p.age_minutes} Min.)
            <button type="button" disabled={busy || !p.request_id} onClick={() => void run(async () => { setPairing(await api.acApprove(agent, p.platform, p.request_id)); })}>Freigeben {p.user_id}</button>
          </li>))}</ul>
        <h3>Freigegeben</h3>
        <ul>{(pairing?.approved ?? []).map((a) => (
          <li key={`${a.platform}:${a.user_id}`}>{a.user_name || a.user_id} ({a.platform}, ID {a.user_id})
            <input aria-label={`ID zum Sperren ${a.user_id}`} placeholder={a.user_id} value={typed[`p:${a.user_id}`] ?? ""} onChange={(e) => setTyped({ ...typed, [`p:${a.user_id}`]: e.target.value })} />
            <button type="button" disabled={busy || typed[`p:${a.user_id}`] !== a.user_id} onClick={() => void run(async () => { setPairing(await api.acRevoke(agent, a.platform, a.user_id, a.user_id)); })}>Sperren {a.user_id}</button>
          </li>))}</ul>
      </section>
      <section aria-label="Webhooks">
        <h2>Webhooks</h2>
        {hooks && !hooks.enabled && (
          <div>
            <p className="banner">Die Webhook-Plattform ist aus. Einschalten startet das Gateway neu und unterbricht laufende Sitzungen.</p>
            <button type="button" disabled={busy} onClick={() => { if (window.confirm("Gateway neu starten und Webhooks einschalten?")) void run(async () => { setHooks(await api.acHooksEnable(agent)); }); }}>Webhooks einschalten</button>
          </div>
        )}
        {secret && <p role="status">Secret für {secret.name}: <code>{secret.secret}</code> (wird nur jetzt angezeigt; URL {secret.url}) <button type="button" onClick={() => setSecret(null)}>Secret ausblenden</button></p>}
        <ul>{(hooks?.subscriptions ?? []).map((h) => (
          <li key={h.name}><strong>{h.name}</strong> {h.url} {h.enabled ? "· an" : "· aus"}
            <button type="button" disabled={busy} onClick={() => void run(async () => { await api.acHookToggle(agent, h.name, !h.enabled); await load(); })}>{h.enabled ? "Ausschalten" : "Einschalten"} {h.name}</button>
            <input aria-label={`Name zum Löschen ${h.name}`} placeholder={h.name} value={typed[`h:${h.name}`] ?? ""} onChange={(e) => setTyped({ ...typed, [`h:${h.name}`]: e.target.value })} />
            <button type="button" disabled={busy || typed[`h:${h.name}`] !== h.name} onClick={() => void run(async () => { await api.acHookDelete(agent, h.name, h.name); await load(); })}>Löschen {h.name}</button>
          </li>))}</ul>
        {hooks?.enabled && (
          <div>
            <h3>Neuer Webhook</h3>
            <label>Name <input aria-label="Webhook-Name" value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label>Ereignisse (Komma) <input aria-label="Ereignisse" value={events} onChange={(e) => setEvents(e.target.value)} /></label>
            <button type="button" disabled={busy || !nameOk} onClick={() => void run(async () => { const c = await api.acHookCreate(agent, { name: name.trim(), events: evList }); setSecret({ name: c.name, url: c.url, secret: c.secret }); setName(""); setEvents(""); await load(); })}>Webhook anlegen</button>
          </div>
        )}
      </section>
    </article>
  );
}
