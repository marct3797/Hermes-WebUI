import { useState } from "react";
import { itemIdOf, secondsLeft, type LiveRun, type Need } from "../../attention";
import { fmtClock, fmtCount, fmtTime } from "../../format";
import { api } from "../../api";
import { agentPath } from "../../router";
import { useRoomNeeds, type RoomNeed } from "../../roomNeeds";
import { useRunStore } from "../../runs";
import type { LogEntry } from "../../runStore";
import type { HostInfo, SigilConfig } from "../../types";
import { sigilFor } from "../../ui";
import { Icon } from "../Icon";
import { Link } from "../Link";
import { Sigil } from "../Sigil";
import { StatusDot } from "../Status";
import { t } from "../../i18n";

type Sigils = Record<string, SigilConfig>;

/** Rechte Spalte: was die Person jetzt entscheiden muss. Freigaben lassen sich direkt beantworten. */
export function NeedsPanel({ needs, roomNeeds = [], log, sigils, now }: { needs: Need[]; roomNeeds?: RoomNeed[]; log: readonly LogEntry[]; sigils: Sigils; now: number }) {
  const store = useRunStore();
  const total = needs.length + roomNeeds.length;
  const recent = log[0] && now - log[0].at < 8000 ? log[0] : undefined;
  return (
    <section className={`card needs-panel${total ? " need" : (recent ? "" : " none")}`} aria-label={t("Braucht dich")}>
      <header className="card-h">
        <Icon name="bell" size={16} className={total ? "crimt" : "t2"} />
        <h2>{t("Braucht dich")}</h2>
        {total > 0 && <span className="ct">{total}</span>}
        <Link to="/inbox" className="mono t3" style={{ marginLeft: "auto", fontSize: 11 }}>{t("alle öffnen →")}</Link>
      </header>
      {recent && (
        <div className="qrow" style={{ background: "var(--s2)" }} role="status">
          <Icon name="shield" size={14} className="t2" />
          <div className="col grow">
            <span className="tt">{t("Entscheidung gespeichert")}</span>
            <span className="ss trunc">{t("{agent} · {text} · Audit-Log {at}", { agent: recent.agent.agent, text: recent.text, at: fmtTime(recent.at) })}</span>
          </div>
        </div>
      )}
      {total === 0 && !recent && <p className="panel-empty">{t("Nichts offen. Freigaben und Rückfragen laufender Runs und Räume erscheinen hier.")}</p>}
      {needs.slice(0, 5).map((n) => {
        const sig = <Sigil name={n.agent.agent} config={sigilFor(sigils, n.agent)} size="s" state={n.kind === "failed" || n.kind === "lost" ? "err" : "wait"} />;
        if (n.kind === "approval") {
          const secs = secondsLeft(n, now)!;
          const itemId = itemIdOf(n);
          return (
            <div key={n.id} className="qrow" style={{ alignItems: "flex-start" }}>
              {sig}
              <div className="col grow" style={{ gap: 8, minWidth: 0 }}>
                <div className="col" style={{ gap: 2 }}>
                  <span className="tt">{t("{agent} fragt nach Freigabe", { agent: n.agent.agent })}</span>
                  <span className="ss trunc">{n.item.command} · {secs > 0 ? `erlischt in ${fmtClock(secs)}` : t("abgelaufen")}</span>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  {n.item.choices.includes("once") && (
                    <button type="button" className="btn btn-p btn-s" disabled={secs <= 0} onClick={() => void store.decide(n.convKey, itemId, "once")}><Icon name="check" size={12} />{t("Einmal erlauben")}</button>
                  )}
                  {n.item.choices.includes("deny") && (
                    <button type="button" className="btn btn-s" disabled={secs <= 0} onClick={() => void store.decide(n.convKey, itemId, "deny")}>{t("Ablehnen")}</button>
                  )}
                </div>
              </div>
            </div>
          );
        }
        if (n.kind === "clarify") {
          return (
            <div key={n.id} className="qrow">
              {sig}
              <div className="col grow"><span className="tt">{t("Rückfrage von {agent}", { agent: n.agent.agent })}</span><span className="ss trunc">{n.item.question}</span></div>
              <Link to="/inbox" className="btn btn-s">{t("Antworten")}</Link>
            </div>
          );
        }
        return (
          <div key={n.id} className="qrow">
            {sig}
            <div className="col grow"><span className="tt" style={{ color: "var(--ruby-t)" }}>{n.kind === "lost" ? t("Verbindung verloren") : t("Run fehlgeschlagen")}</span><span className="ss trunc">{n.agent.agent} · {n.error}</span></div>
            <Link to="/inbox" className="btn btn-s">{t("Ansehen")}</Link>
          </div>
        );
      })}
      {roomNeeds.slice(0, 3).map((n) => <RoomNeedRow key={n.id} need={n} sigils={sigils} />)}
      {needs.length > 5 && <Link to="/inbox" className="qrow mono t3" style={{ fontSize: 11 }}>{t("{v} weitere in der Inbox →", { v: needs.length - 5 })}</Link>}
      {roomNeeds.length > 3 && <Link to="/inbox" className="qrow mono t3" style={{ fontSize: 11 }}>{t("{v} weitere aus Räumen in der Inbox →", { v: roomNeeds.length - 3 })}</Link>}
    </section>
  );
}

/** Eine Freigabe, Rückfrage oder ein Ruf aus einem Raum. Freigaben lassen sich hier direkt beantworten, alles andere im Raum oder in der Inbox. */
function RoomNeedRow({ need, sigils }: { need: RoomNeed; sigils: Sigils }) {
  const { refresh } = useRoomNeeds();
  const [busy, setBusy] = useState(false);
  const { ask, member, room } = need;
  const decide = async (choice: "once" | "deny") => {
    if (!ask || ask.kind !== "approval" || !member) return;
    setBusy(true);
    try { await api.approve(member, ask.runId, choice); refresh(); setTimeout(refresh, 2000); } catch { /* der Raum zeigt den Fehler */ } finally { setBusy(false); }
  };
  const sig = member ? <Sigil name={member.label} config={sigilFor(sigils, member)} size="s" state="wait" /> : <Icon name="orbit" size={16} className="t2" />;
  if (ask?.kind === "approval" && member) {
    return (
      <div className="qrow" style={{ alignItems: "flex-start" }}>
        {sig}
        <div className="col grow" style={{ gap: 8, minWidth: 0 }}>
          <div className="col" style={{ gap: 2 }}>
            <span className="tt">{t("{label} fragt nach Freigabe", { label: member.label })}</span>
            <span className="ss trunc">{t("{command} · Raum {name}", { command: ask.command, name: room.name })}</span>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {ask.choices.includes("once") && <button type="button" className="btn btn-p btn-s" disabled={busy} onClick={() => void decide("once")}><Icon name="check" size={12} />{t("Einmal erlauben")}</button>}
            {ask.choices.includes("deny") && <button type="button" className="btn btn-s" disabled={busy} onClick={() => void decide("deny")}>{t("Ablehnen")}</button>}
            <Link to={`/rooms/${room.id}`} className="btn btn-s btn-g">{t("Raum öffnen")}</Link>
          </div>
        </div>
      </div>
    );
  }
  if (ask) {
    return (
      <div className="qrow">
        {sig}
        <div className="col grow"><span className="tt">{t("Rückfrage von {label}", { label: member?.label ?? t("einem Mitglied") })}</span><span className="ss trunc">{t("{question} · Raum {name}", { question: ask.kind === "clarify" ? ask.question : "", name: room.name })}</span></div>
        <Link to="/inbox" className="btn btn-s">{t("Antworten")}</Link>
      </div>
    );
  }
  return (
    <div className="qrow">
      {sig}
      <div className="col grow"><span className="tt">{t("Raum {name} ruft dich", { name: room.name })}</span><span className="ss trunc">{t("Ein Agent hat dich mit @user gerufen.")}</span></div>
      <Link to={`/rooms/${room.id}`} className="btn btn-s">{t("Öffnen")}</Link>
    </div>
  );
}

/** Runs, die gerade laufen: wer, seit wann, was gerade passiert. Der Balken zeigt nur Bewegung, keinen Fortschritt. */
export function RunningPanel({ live, sigils, now }: { live: LiveRun[]; sigils: Sigils; now: number }) {
  return (
    <section className="card run-panel" aria-label={t("Läuft gerade")}>
      <header className="card-h">
        <Icon name="cpu" size={16} className="t2" />
        <h2>{t("Läuft gerade")}</h2>
        <span className="mono t3" style={{ marginLeft: "auto", fontSize: 11 }}>{live.length} {live.length === 1 ? t("Run") : t("Runs")}</span>
      </header>
      {live.length === 0 && <p className="panel-empty">{t("Gerade läuft nichts, das diese WebUI gestartet hat.")}</p>}
      {live.map((r) => (
        <Link key={r.convKey} to={agentPath(r.agent, "chat", r.sessionId)} className="wrow">
          <div className="row" style={{ gap: 10 }}>
            <Sigil name={r.agent.agent} config={sigilFor(sigils, r.agent)} size="xs" />
            <span style={{ fontWeight: 600, fontSize: 12.5 }}>{r.agent.agent}</span>
            <span className="mono t3" style={{ marginLeft: "auto", fontSize: 10.5 }}>
              {[r.startedAt ? fmtClock((now - r.startedAt) / 1000) : "", r.tokens ? `${fmtCount(r.tokens)} tok` : ""].filter(Boolean).join(" · ")}
            </span>
          </div>
          <span className="mono t2 trunc" style={{ fontSize: 11 }}>{r.activity}</span>
          <div className={`prog ${r.waiting ? "hold" : "ind"}`}><b /></div>
        </Link>
      ))}
    </section>
  );
}

/** Erreichbarkeit der Hosts und Runtimes, wie die Registry sie meldet. */
export function SystemPanel({ hosts, configError }: { hosts: HostInfo[]; configError?: string | null }) {
  return (
    <section className="card sys-panel" aria-label={t("System")}>
      <header className="card-h"><Icon name="server" size={16} className="t2" /><h2>{t("System")}</h2></header>
      {hosts.map((h) => h.runtimes.length === 0
        ? <div key={h.id} className="sysrow"><StatusDot status={h.status} />{h.label}<span className="r">{h.address ?? t("lokal")}</span></div>
        : h.runtimes.map((r) => (
          <div key={`${h.id}/${r.id}`} className="sysrow" title={r.detail ?? undefined}>
            <StatusDot status={r.status} />{h.id} · {r.label}
            <span className="r">{[r.version, `${r.agents.length} ${r.agents.length === 1 ? t("Agent") : t("Agents")}`].filter(Boolean).join(" · ")}</span>
          </div>
        )))}
      {configError && <div className="sysrow" role="alert" style={{ color: "var(--ruby-t)", whiteSpace: "normal" }}><i className="dot dot-err" />{t("Konfiguration: {configError}", { configError })}</div>}
    </section>
  );
}
