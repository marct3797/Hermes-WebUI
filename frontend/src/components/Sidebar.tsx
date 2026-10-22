import { useHosts } from "../hosts";
import { agentPath, sameAgent } from "../router";
import type { AgentRef, Me, SessionSummary } from "../types";
import { Link } from "./Link";
import { Monogram, StatusDot } from "./Status";

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
  { to: "/", label: "Cockpit" },
  { to: "/inbox", label: "Inbox" },
  { to: "/hosts", label: "Hosts" },
];

export function Sidebar(p: Props) {
  const { hosts, error } = useHosts();
  return (
    <>
      {p.open && <div className="scrim" onClick={p.onClose} aria-hidden />}
      <aside className={`sidebar${p.open ? " open" : ""}`} aria-label="Navigation">
        <Link to="/" className="brand mono" onClick={p.onClose}>HERMES</Link>

        <nav aria-label="Übersicht" className="nav">
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} className="nav-link" aria-current={p.path === n.to ? "page" : undefined} onClick={p.onClose}>
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="hosts-scroll">
          {error && <p className="error small" role="alert">Hosts nicht ladbar: {error}</p>}
          {!hosts && !error && <p className="muted small">Lade…</p>}
          {hosts?.map((h) => (
            <section key={h.id} className="host-group" aria-label={h.label}>
              <h2 className="host-head">
                <StatusDot status={h.status} />
                <span>{h.label}</span>
                {h.kind === "remote" && <span className="mono tag">remote</span>}
              </h2>
              {h.status !== "online" && h.detail && <p className="muted small host-detail">{h.detail}</p>}
              {h.runtimes.map((r) => (
                <div key={r.id}>
                  {h.runtimes.length > 1 && <p className="runtime-head mono">{r.label}</p>}
                  <ul className="agents">
                    {r.agents.map((a) => {
                      const ref = { host: h.id, runtime: r.id, agent: a.id };
                      const isActive = sameAgent(p.active, ref);
                      return (
                        <li key={a.id}>
                          <Link to={agentPath(ref)} className={`agent-link${isActive ? " active" : ""}${r.status !== "online" ? " offline" : ""}`}
                            aria-current={isActive && !p.sessionId ? "page" : undefined} onClick={p.onClose}>
                            <Monogram name={a.label} />
                            <span className="agent-name">{a.label}</span>
                          </Link>
                          {isActive && (
                            <div className="sessions" role="group" aria-label={`Sessions von ${a.label}`}>
                              <Link to={agentPath(ref)} className="session new" onClick={p.onClose}>+ Neuer Chat</Link>
                              {p.sessionsLoading && <p className="muted small">Lade…</p>}
                              {p.sessions.map((s) => (
                                <Link key={s.id} to={agentPath(ref, "chat", s.id)} className={`session${s.id === p.sessionId ? " active" : ""}`}
                                  aria-current={s.id === p.sessionId ? "page" : undefined} onClick={p.onClose}>
                                  <span className="title">{s.title}</span>
                                  {s.source && s.source !== "chat" && <span className="mono tag">{s.source}</span>}
                                </Link>
                              ))}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </section>
          ))}
        </div>

        <footer className="side-foot">
          <span className="mono small" title={p.me.user.id}>{p.me.user.name}</span>
          {p.me.auth_mode === "oidc" && <button type="button" className="ghost small" onClick={p.onLogout}>Abmelden</button>}
        </footer>
      </aside>
    </>
  );
}
