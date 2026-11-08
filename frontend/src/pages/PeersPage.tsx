import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { PageHead } from "../components/PageHead";
import { useAction } from "../components/useAction";
import type { AgentRef, PeerRow, PeerRun } from "../types";
import { t } from "../i18n";

type Sent = { target: string; run: PeerRun };

export default function PeersPage({ agent }: { agent: AgentRef }) {
  const [rows, setRows] = useState<PeerRow[] | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [note, setNote] = useState("");
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [to, setTo] = useState("");
  const [profile, setProfile] = useState("");
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState<Sent[]>([]);
  const { run, notes, busy } = useAction();
  const load = useCallback(() => api.peerList(agent).then((l) => { setRows(l.peers); setLoadErr(""); }, (e: Error) => { setLoadErr(e.message); }), [agent.host, agent.runtime, agent.agent]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);

  const usable = (rows ?? []).filter((r) => r.has_key);
  const peer = to || usable[0]?.name || "";
  const target = peer && profile.trim() ? `${peer}/${profile.trim()}` : peer;
  const known = (rows ?? []).some((r) => r.name === name.trim().toLowerCase());
  const addReady = /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name.trim().toLowerCase()) && /^https?:\/\/\S+$/.test(url.trim()) && (key.trim() || known);

  const add = async () => {
    const ok = await run(async () => {
      await api.peerAdd(agent, { name: name.trim().toLowerCase(), url: url.trim(), ...(key.trim() ? { key: key.trim() } : {}), note: note.trim() });
      setName(""); setUrl(""); setKey(""); setNote("");   // Schlüssel sofort aus dem Speicher der Maske
      await load();
    });
    if (!ok) void load();
  };
  const send = async () => {
    const ok = await run(async () => {
      const r = await api.peerSend(agent, { target, message, idempotency_key: `ui-${crypto.randomUUID()}` });
      setSent((o) => [{ target, run: r }, ...o].slice(0, 10));
      setMessage("");
    });
    void ok;   // nach Zeitüberschreitung nicht blind noch einmal senden: der Peer hat die Nachricht eventuell schon
  };
  const refresh = (s: Sent, stop: boolean) => run(async () => {
    const r = stop ? await api.peerStop(agent, s.target, s.run.run_id ?? "") : await api.peerStatus(agent, s.target, s.run.run_id ?? "");
    setSent((o) => o.map((x) => (x === s ? { ...x, run: { ...x.run, ...r } } : x)));
  });

  return (
    <article>
      <PageHead title={t("Bot-Modus und Peers")} sub={t("Andere Hermes-Gateways als Gesprächspartner dieses Agents")} />
      <p className="muted">{t("Ein Peer ist ein anderes Hermes-Gateway mit API-Server. Nachrichten gehen als Lauf in den „Bot Chat“ des Peers; seine Antwort holst du über den Status. Der API-Schlüssel des Peers wird nur an Hermes übergeben und nie angezeigt.")}</p>
      {notes}
      {loadErr && <p className="banner" role="alert">{loadErr}</p>}
      <section aria-label={t("Eingetragene Peers")}>
        <h2>{t("Eingetragene Peers")}</h2>
        {rows && rows.length === 0 && <p>{t("Noch kein Peer eingetragen.")}</p>}
        <ul>{(rows ?? []).map((r) => (
          <li key={r.name}>
            <strong>{r.name}</strong> <span className="muted">{r.url}{r.note ? ` · ${r.note}` : ""} · {r.has_key ? t("Schlüssel gesetzt") : t("kein Schlüssel")}</span>
            <input aria-label={t("Zum Entfernen den Namen eintippen: {name}", { name: r.name })} placeholder={r.name} value={typed[r.name] ?? ""} onChange={(e) => { const v = e.target.value; setTyped((o) => ({ ...o, [r.name]: v })); }} />
            <button type="button" disabled={busy || typed[r.name]?.trim() !== r.name} onClick={() => void run(async () => { await api.peerRemove(agent, r.name, r.name); setTyped((o) => ({ ...o, [r.name]: "" })); await load(); })}>{t("Entfernen {name}", { name: r.name })}</button>
          </li>))}</ul>
        <h3>{t("Peer eintragen oder ändern")}</h3>
        <p className="muted">{t("Die Adresse bekommt den Schlüssel als Bearer-Token: trage nur Gateways ein, denen du traust. Ohne neuen Schlüssel bleibt der alte erhalten.")}</p>
        <label>{t("Name")} <input aria-label={t("Name des Peers")} placeholder="spark" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>{t("Adresse")} <input aria-label={t("Adresse des Peers")} placeholder="http://spark.lan:8377" value={url} onChange={(e) => setUrl(e.target.value)} /></label>
        <label>{t("API-Schlüssel des Peers")} <input type="password" aria-label={t("API-Schlüssel des Peers")} autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} /></label>
        <label>{t("Notiz")} <input aria-label={t("Notiz zum Peer")} value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <button type="button" disabled={busy || !addReady} onClick={() => void add()}>{t("Peer speichern")}</button>
      </section>
      <section aria-label={t("Nachricht senden")}>
        <h2>{t("Nachricht senden")}</h2>
        {usable.length === 0 ? <p className="muted">{t("Senden geht nur an eingetragene Peers mit Schlüssel.")}</p> : <>
          <label>{t("Peer")} <select aria-label={t("Peer")} value={peer} onChange={(e) => setTo(e.target.value)}>{usable.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}</select></label>
          <label>{t("Agent beim Peer (optional)")} <input aria-label={t("Agent beim Peer")} placeholder="researcher" value={profile} onChange={(e) => setProfile(e.target.value)} /></label>
          <label>{t("Nachricht")} <textarea aria-label={t("Nachricht an den Peer")} maxLength={20000} value={message} onChange={(e) => setMessage(e.target.value)} /></label>
          <button type="button" disabled={busy || !message.trim() || !/^[a-z0-9][a-z0-9_-]*(\/[A-Za-z0-9][A-Za-z0-9_-]*)?$/.test(target)} onClick={() => void send()}>{t("An {peer} senden", { peer: target })}</button>
        </>}
        <ul>{sent.map((s) => (
          <li key={s.run.run_id}>
            <strong>{s.target}</strong> <span className="muted">{s.run.run_id} · {s.run.status ?? ""}</span>
            <button type="button" disabled={busy} onClick={() => void refresh(s, false)}>{t("Status von {run}", { run: s.run.run_id ?? "" })}</button>
            <button type="button" disabled={busy} onClick={() => void refresh(s, true)}>{t("Lauf {run} stoppen", { run: s.run.run_id ?? "" })}</button>
            {s.run.output && <pre aria-label={t("Antwort {run}", { run: s.run.run_id ?? "" })}>{s.run.output}</pre>}
            {s.run.error && <p className="muted">{s.run.error}</p>}
          </li>))}</ul>
      </section>
    </article>
  );
}
