import { useHosts } from "../hosts";
import { agentKey, agentPath, sameAgent } from "../router";
import { useActivity } from "../runs";
import type { AgentRef, Me, SessionSummary } from "../types";
import { sigilFor, useUi } from "../ui";
import { Icon } from "./Icon";
import { Link } from "./Link";
import { Sigil } from "./Sigil";
import { AgentDot, StatusDot } from "./Status";

type Props = {
  me: Me;
  path: string;
  active?: AgentRef;
  sessionId?: string;
  sessions: SessionSummary[];
  sessionsLoading: boolean;
  open: boolean;
  onClose: () => void;
  onLogout: () => void;
};

const NAV = [
  { to: "/", label: "Cockpit", icon: "grid" },
  { to: "/inbox", label: "Inbox", icon: "inbox" },
  { to: "/hosts", label: "Hosts", icon: "server" },
];
// Module, die noch nicht gebaut sind: sichtbar, aber ohne Ziel.
const SOON = [
  { label: "Kanban", icon: "kanban" },
  { label: "Memory", icon: "memory" },
];

export function Sidebar(p: Props) {
  const { hosts, error } = useHosts();
  const { sigils } = useUi();
  const { needs, byAgent } = useActivity();
  return (
    <>
      {p.open && <div className="scrim" onClick={p.onClose} aria-hidden />}
      <aside className={`side${p.open ? " open" : ""}`} aria-label="Navigation">
        <Link to="/" className="brand" onClick={p.onClose} aria-label="Hermes, zum Cockpit">
          <span className="mk" aria-hidden />
          <b>HERMES</b>
          <span className="tag" style={{ marginLeft: "auto" }}>WEBUI</span>
        </Link>

        <div className="side-scroll">
          <nav aria-label="Übersicht" className="nav">
            {NAV.map((n) => (
              <Link key={n.to} to={n.to} className={p.path === n.to ? "on" : undefined} aria-current={p.path === n.to ? "page" : undefined} onClick={p.onClose}>
                <Icon name={n.icon} size={18} />{n.label}
                {n.to === "/inbox" && needs.length > 0 && <span className="ct" aria-label={`${needs.length} offen`}>{needs.length}</span>}
              </Link>
            ))}
            {SOON.map((n) => (
              <span key={n.label} className="soon" style={{ display: "flex", alignItems: "center", gap: 10, height: 34, padding: "0 10px", fontWeight: 500 }} aria-disabled="true">
                <Icon name={n.icon} size={18} />{n.label}<span className="tag">PHASE 3</span>
              </span>
            ))}
          </nav>

          {error && <p className="error small" role="alert" style={{ padding: "0 16px" }}>Hosts nicht ladbar: {error}</p>}
          {!hosts && !error && <p className="muted small" style={{ padding: "0 16px" }}>Lade…</p>}
          {hosts?.map((h) => (
            <section key={h.id} aria-label={h.label}>
              <h2 className="hostbar">
                <StatusDot status={h.status} />
                <b>{h.label.toUpperCase()}</b>
                {h.kind === "remote" && <span className="tag">remote</span>}
                <span className="r">{h.runtimes.map((r) => `${r.id} · ${r.agents.length}`).join(" · ")}</span>
              </h2>
              {h.status !== "online" && h.detail && <p className="muted small" style={{ padding: "0 16px 4px" }}>{h.detail}</p>}
              {h.runtimes.map((r) => (
                <div key={r.id}>
                  {h.runtimes.length > 1 && <p className="lbl" style={{ padding: "4px 16px 2px" }}>{r.label}</p>}
                  {r.agents.map((a) => {
                    const ref = { host: h.id, runtime: r.id, agent: a.id };
                    const isActive = sameAgent(p.active, ref);
                    const act = byAgent.get(agentKey(ref));
                    return (
                      <div key={a.id}>
                        <Link to={agentPath(ref)} className={`agent${isActive ? " on" : ""}`}
                          aria-current={isActive && !p.sessionId ? "page" : undefined} onClick={p.onClose}
                          style={r.status !== "online" ? { opacity: 0.7 } : undefined}>
                          <Sigil name={a.label} config={sigilFor(sigils, ref)} size="xs" />
                          <span className="grow trunc">{a.label}</span>
                          {act && act.waiting > 0 && <span className="ct" aria-label={`${act.waiting} wartet auf dich`}>{act.waiting}</span>}
                          <AgentDot act={act} status={r.status} />
                        </Link>
                        {isActive && (
                          <div className="side-sessions" role="group" aria-label={`Sessions von ${a.label}`}>
                            <Link to={agentPath(ref)} onClick={p.onClose}><Icon name="plus" size={14} />Neuer Chat</Link>
                            {p.sessionsLoading && <p className="muted small" style={{ padding: "0 8px" }}>Lade…</p>}
                            {p.sessions.map((s) => (
                              <Link key={s.id} to={agentPath(ref, "chat", s.id)} className={s.id === p.sessionId ? "on" : undefined}
                                aria-current={s.id === p.sessionId ? "page" : undefined} onClick={p.onClose}>
                                <span className="trunc">{s.title}</span>
                                {s.source && s.source !== "chat" && <span className="tag" style={{ marginLeft: "auto" }}>{s.source}</span>}
                              </Link>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </section>
          ))}
        </div>

        <footer className="side-foot">
          <span className="avatar" aria-hidden>{p.me.user.name.slice(0, 1).toUpperCase()}</span>
          <span className="who"><b title={p.me.user.id}>{p.me.user.name}</b></span>
          {p.me.auth_mode === "oidc" && <button type="button" className="btn btn-s btn-g" onClick={p.onLogout}>Abmelden</button>}
        </footer>
      </aside>
    </>
  );
}
