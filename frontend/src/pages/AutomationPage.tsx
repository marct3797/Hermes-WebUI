import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { Icon } from "../components/Icon";
import { PageHead } from "../components/PageHead";
import { fmtAgo, fmtDuration, loc } from "../format";
import { N_, t } from "../i18n";
import type { AgentRef, AutomationItem, AutomationResp } from "../types";

const KINDS = [
  { kind: "goal", title: N_("Ziele"), empty: N_("Keine Ziele gesetzt.") },
  { kind: "loop", title: N_("Schleifen"), empty: N_("Keine Schleifen aktiv.") },
  { kind: "heartbeat", title: N_("Heartbeats"), empty: N_("Keine Heartbeats gesetzt.") },
] as const;
const STATUS: Record<string, string> = { active: N_("aktiv"), paused: N_("pausiert"), done: N_("erledigt") };
const tone = (s: string | null) => (s === "active" ? "ok" : s === "paused" ? "warn" : "");
const ms = (s?: number | null) => (s ? s * 1000 : 0);

function Detail({ i }: { i: AutomationItem }) {
  const bits: string[] = [];
  if (i.kind === "goal") {
    if (i.turns_used != null && i.max_turns) bits.push(t("{used} von {max} Runden", { used: i.turns_used, max: i.max_turns }));
    if (i.gates) bits.push(t("{n} Prüfschritte", { n: i.gates }));
    if (i.last_turn_at) bits.push(t("zuletzt {ago}", { ago: fmtAgo(ms(i.last_turn_at)) }));
  } else if (i.kind === "heartbeat") {
    if (i.interval_seconds) bits.push(t("alle {interval}", { interval: fmtDuration(i.interval_seconds * 1000) }));
    if (i.fire_count != null) bits.push(t("{n}-mal ausgelöst", { n: i.fire_count }));
    if (i.last_fired_at) bits.push(t("zuletzt {ago}", { ago: fmtAgo(ms(i.last_fired_at)) }));
  } else {
    bits.push(i.mode === "self_paced" ? t("selbstgesteuert") : t("alle {interval}", { interval: fmtDuration((i.interval_seconds ?? 0) * 1000) }));
    if (i.ticks_fired != null) bits.push(t("{n}-mal ausgelöst", { n: i.ticks_fired }));
    if (i.status === "active" && i.next_due_at) bits.push(t("nächster Lauf um {time}", { time: new Date(ms(i.next_due_at)).toLocaleTimeString(loc(), { hour: "2-digit", minute: "2-digit" }) }));
  }
  const why = i.paused_reason || i.last_reason;
  return (
    <>
      <p className="muted small mono">{bits.join(" · ")}</p>
      {i.until && <p className="muted small">{t("Ende, wenn: {until}", { until: i.until })}</p>}
      {i.subgoals && i.subgoals.length > 0 && <ul className="muted small">{i.subgoals.map((s) => <li key={s}>{s}</li>)}</ul>}
      {why && <p className="muted small">{why}</p>}
    </>
  );
}

/** Ziele, Heartbeats und Schleifen der Sitzungen eines Profils. Nur Ansicht: Hermes führt /goal, /heartbeat und /loop nur in Terminal, Desktop und Messaging aus. */
export function AutomationPage({ agent, label }: { agent: AgentRef; label: string }) {
  const [data, setData] = useState<AutomationResp>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => api.automation(agent).then((r) => { setData(r); setError(undefined); }, (e: Error) => {
    setData(undefined);
    setError(e instanceof ApiError && e.status === 503 ? t("Host-Dienst nicht eingerichtet") : e.message);
  }), [agent.host, agent.runtime, agent.agent]);
  useEffect(() => { void load(); }, [load]);
  return (
    <main className="page">
      <PageHead title={t("Ziele und Schleifen")} sub={label} />
      <p className="banner"><Icon name="info" /><span>{t("Nur Ansicht. Hermes führt /goal, /heartbeat und /loop nur in Terminal, Desktop oder Messaging aus. Setzen, pausieren und löschen geht dort.")}</span></p>
      {error && <p className="banner" role="alert"><Icon name="alert" />{error}</p>}
      {!data && !error && <p className="muted">{t("Lade…")}</p>}
      {data && !data.available && <p className="banner" role="status"><Icon name="alert" />{t("Die Sitzungsdatenbank dieses Profils ist nicht lesbar.")}</p>}
      {data && data.available && KINDS.map((k) => {
        const rows = data.items.filter((i) => i.kind === k.kind);
        return (
          <section key={k.kind} aria-label={t(k.title)}>
            <h2>{t(k.title)} <span className="muted small">{rows.length}</span></h2>
            {rows.length === 0 ? <p className="muted small">{t(k.empty)}</p> : (
              <ul className="ext-list">
                {rows.map((i) => (
                  <li key={`${i.kind}:${i.session_id}`} className="card ext-detail">
                    <div><span className={`ext-pill ${tone(i.status)}`}>{STATUS[i.status ?? ""] ? t(STATUS[i.status ?? ""]) : i.status}</span> <b>{i.text}</b></div>
                    <p className="muted small">{t("Sitzung: {title}", { title: i.title || i.session_id })}</p>
                    <Detail i={i} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      {data?.truncated && <p className="muted small">{t("Die Liste ist gekürzt.")}</p>}
    </main>
  );
}
