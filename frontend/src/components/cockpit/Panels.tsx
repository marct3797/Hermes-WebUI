import { itemIdOf, secondsLeft, type LiveRun, type Need } from "../../attention";
import { fmtClock, fmtCount, fmtTime } from "../../format";
import { agentPath } from "../../router";
import { useRunStore } from "../../runs";
import type { LogEntry } from "../../runStore";
import type { HostInfo, SigilConfig } from "../../types";
import { sigilFor } from "../../ui";
import { Icon } from "../Icon";
import { Link } from "../Link";
import { Sigil } from "../Sigil";
import { StatusDot } from "../Status";

type Sigils = Record<string, SigilConfig>;

/** Rechte Spalte: was die Person jetzt entscheiden muss. Freigaben lassen sich direkt beantworten. */
export function NeedsPanel({ needs, log, sigils, now }: { needs: Need[]; log: readonly LogEntry[]; sigils: Sigils; now: number }) {
  const store = useRunStore();
  const recent = log[0] && now - log[0].at < 8000 ? log[0] : undefined;
  return (
    <section className={`card needs-panel${needs.length ? " need" : (recent ? "" : " none")}`} aria-label="Braucht dich">
      <header className="card-h">
        <Icon name="bell" size={16} className={needs.length ? "crimt" : "t2"} />
        <h2>Braucht dich</h2>
        {needs.length > 0 && <span className="ct">{needs.length}</span>}
        <Link to="/inbox" className="mono t3" style={{ marginLeft: "auto", fontSize: 11 }}>alle öffnen →</Link>
      </header>
      {recent && (
        <div className="qrow" style={{ background: "var(--s2)" }} role="status">
          <Icon name="shield" size={14} className="t2" />
          <div className="col grow">
            <span className="tt">Entscheidung gespeichert</span>
            <span className="ss trunc">{recent.agent.agent} · {recent.text} · Audit-Log {fmtTime(recent.at)}</span>
          </div>
        </div>
      )}
      {needs.length === 0 && !recent && <p className="panel-empty">Nichts offen. Freigaben und Rückfragen laufender Runs erscheinen hier.</p>}
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
                  <span className="tt">{n.agent.agent} fragt nach Freigabe</span>
                  <span className="ss trunc">{n.item.command} · {secs > 0 ? `erlischt in ${fmtClock(secs)}` : "abgelaufen"}</span>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  {n.item.choices.includes("once") && (
                    <button type="button" className="btn btn-p btn-s" disabled={secs <= 0} onClick={() => void store.decide(n.convKey, itemId, "once")}><Icon name="check" size={12} />Einmal erlauben</button>
                  )}
                  {n.item.choices.includes("deny") && (
                    <button type="button" className="btn btn-s" disabled={secs <= 0} onClick={() => void store.decide(n.convKey, itemId, "deny")}>Ablehnen</button>
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
              <div className="col grow"><span className="tt">Rückfrage von {n.agent.agent}</span><span className="ss trunc">{n.item.question}</span></div>
              <Link to="/inbox" className="btn btn-s">Antworten</Link>
            </div>
          );
        }
        return (
          <div key={n.id} className="qrow">
            {sig}
            <div className="col grow"><span className="tt" style={{ color: "var(--ruby-t)" }}>{n.kind === "lost" ? "Verbindung verloren" : "Run fehlgeschlagen"}</span><span className="ss trunc">{n.agent.agent} · {n.error}</span></div>
            <Link to="/inbox" className="btn btn-s">Ansehen</Link>
          </div>
        );
      })}
      {needs.length > 5 && <Link to="/inbox" className="qrow mono t3" style={{ fontSize: 11 }}>{needs.length - 5} weitere in der Inbox →</Link>}
    </section>
  );
}

/** Runs, die gerade laufen: wer, seit wann, was gerade passiert. Der Balken zeigt nur Bewegung, keinen Fortschritt. */
export function RunningPanel({ live, sigils, now }: { live: LiveRun[]; sigils: Sigils; now: number }) {
  return (
    <section className="card run-panel" aria-label="Läuft gerade">
      <header className="card-h">
        <Icon name="cpu" size={16} className="t2" />
        <h2>Läuft gerade</h2>
        <span className="mono t3" style={{ marginLeft: "auto", fontSize: 11 }}>{live.length} {live.length === 1 ? "Run" : "Runs"}</span>
      </header>
      {live.length === 0 && <p className="panel-empty">Gerade läuft nichts, das diese WebUI gestartet hat.</p>}
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
    <section className="card sys-panel" aria-label="System">
      <header className="card-h"><Icon name="server" size={16} className="t2" /><h2>System</h2></header>
      {hosts.map((h) => h.runtimes.length === 0
        ? <div key={h.id} className="sysrow"><StatusDot status={h.status} />{h.label}<span className="r">{h.address ?? "lokal"}</span></div>
        : h.runtimes.map((r) => (
          <div key={`${h.id}/${r.id}`} className="sysrow" title={r.detail ?? undefined}>
            <StatusDot status={r.status} />{h.id} · {r.label}
            <span className="r">{[r.version, `${r.agents.length} ${r.agents.length === 1 ? "Agent" : "Agents"}`].filter(Boolean).join(" · ")}</span>
          </div>
        )))}
      {configError && <div className="sysrow" role="alert" style={{ color: "var(--ruby-t)", whiteSpace: "normal" }}><i className="dot dot-err" />Konfiguration: {configError}</div>}
    </section>
  );
}
