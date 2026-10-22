import { useHosts } from "../../hosts";
import { agentPath, sameAgent } from "../../router";
import { useShell } from "../../shell";
import type { AgentRef, Me } from "../../types";
import { sigilFor, useUi } from "../../ui";
import { Icon } from "../Icon";
import { Link } from "../Link";
import { Sigil } from "../Sigil";
import { dotClass } from "../Status";

type Props = { me: Me; active: AgentRef; onLogout: () => void };

/** Schmale Leiste links im Chat: Module oben, darunter alle Agents mit Zustand. Die Seitenleiste ersetzt sie auf schmalen Schirmen. */
export function Rail({ me, active, onLogout }: Props) {
  const { hosts } = useHosts();
  const { sigils } = useUi();
  const { run } = useShell();
  return (
    <nav className="irail" aria-label="Navigation">
      <Link to="/" className="mk-link" aria-label="Hermes, zum Cockpit"><i className="mk" /></Link>
      <Link to="/" className="ib" aria-label="Cockpit"><Icon name="grid" size={20} /></Link>
      <Link to="/inbox" className="ib" aria-label="Inbox"><Icon name="inbox" size={20} /></Link>
      <Link to={agentPath(active)} className="ib on" aria-label="Chats" aria-current="page"><Icon name="chat" size={20} /></Link>
      <span className="ib soon" aria-label="Kanban (folgt)" title="Kanban (folgt)"><Icon name="kanban" size={20} /></span>
      <span className="ib soon" aria-label="Memory (folgt)" title="Memory (folgt)"><Icon name="memory" size={20} /></span>
      {hosts?.map((h) => (
        <div key={h.id} className="rail-group" role="group" aria-label={h.label}>
          <i className="gap" />
          {h.runtimes.flatMap((r) => r.agents.map((a) => {
            const ref = { host: h.id, runtime: r.id, agent: a.id };
            const on = sameAgent(active, ref);
            // Den Zustand des laufenden Chats kennt nur die geöffnete Ansicht; für alle anderen zählt der Host-Status.
            const dot = on && run.waiting ? "dot-wait" : on && (run.status === "running" || run.status === "starting") ? "dot-run" : dotClass(r.status);
            return (
              <Link key={`${h.id}/${r.id}/${a.id}`} to={agentPath(ref)} className={`pf${on ? " on" : ""}`}
                aria-label={`${a.label} auf ${h.label}`} title={`${a.label} · ${h.label}`}>
                <Sigil name={a.label} config={sigilFor(sigils, ref)} size="s" />
                <i className={`dot st ${dot}`} />
              </Link>
            );
          }))}
        </div>
      ))}
      <span className="avatar rail-user" title={me.user.name} role="img" aria-label={`Angemeldet als ${me.user.name}`}>{me.user.name.slice(0, 1).toUpperCase()}</span>
      {me.auth_mode === "oidc" && (
        <button type="button" className="ib" aria-label="Abmelden" title="Abmelden" onClick={onLogout}><Icon name="power" size={18} /></button>
      )}
    </nav>
  );
}
