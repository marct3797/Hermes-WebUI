import { useHosts } from "../../hosts";
import { agentKey, agentPath, sameAgent } from "../../router";
import { useActivity } from "../../runs";
import type { AgentRef, Me } from "../../types";
import { sigilFor, useUi } from "../../ui";
import { Icon } from "../Icon";
import { Link } from "../Link";
import { Sigil } from "../Sigil";
import { activityDot } from "../Status";
import { t } from "../../i18n";

type Props = { me: Me; active: AgentRef; onLogout: () => void };

/** Schmale Leiste links im Chat: Module oben, darunter alle Agents mit Zustand. Die Seitenleiste ersetzt sie auf schmalen Schirmen. */
export function Rail({ me, active, onLogout }: Props) {
  const { hosts } = useHosts();
  const { sigils } = useUi();
  const { needs, byAgent } = useActivity();
  return (
    <nav className="irail" aria-label={t("Navigation")}>
      <Link to="/" className="mk-link" aria-label={t("Hermes, zum Cockpit")}><i className="mk" /></Link>
      <Link to="/" className="ib" aria-label={t("Cockpit")}><Icon name="grid" size={20} /></Link>
      <Link to="/inbox" className="ib" aria-label={needs.length ? `Inbox, ${needs.length} offen` : t("Inbox")}>
        <Icon name="inbox" size={20} />{needs.length > 0 && <span className="ct">{needs.length}</span>}
      </Link>
      <Link to={agentPath(active)} className="ib on" aria-label={t("Chats")} aria-current="page"><Icon name="chat" size={20} /></Link>
      <span className="ib soon" aria-label={t("Kanban (folgt)")} title={t("Kanban (folgt)")}><Icon name="kanban" size={20} /></span>
      <Link to="/rooms" className="ib" aria-label={t("Räume")} title={t("Räume")}><Icon name="orbit" size={20} /></Link>
      <Link to="/memory" className="ib" aria-label={t("Gedächtnis")} title={t("Gedächtnis")}><Icon name="memory" size={20} /></Link>
      {hosts?.map((h) => (
        <div key={h.id} className="rail-group" role="group" aria-label={h.label}>
          <i className="gap" />
          {h.runtimes.flatMap((r) => r.agents.map((a) => {
            const ref = { host: h.id, runtime: r.id, agent: a.id };
            const on = sameAgent(active, ref);
            const act = byAgent.get(agentKey(ref));
            const dot = activityDot(act, r.status);
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
      <Link to="/settings" className="ib rail-user-link" aria-label={t("Darstellung")} title={t("Darstellung")}><Icon name="sliders" size={18} /></Link>
      <span className="avatar rail-user" title={me.user.name} role="img" aria-label={`Angemeldet als ${me.user.name}`}>{me.user.name.slice(0, 1).toUpperCase()}</span>
      {me.auth_mode === "oidc" && (
        <button type="button" className="ib" aria-label={t("Abmelden")} title={t("Abmelden")} onClick={onLogout}><Icon name="power" size={18} /></button>
      )}
    </nav>
  );
}
