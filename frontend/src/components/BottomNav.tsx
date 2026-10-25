import { useEffect, useState } from "react";
import { useKnowledgeProviders } from "../knowledge";
import { useRoomNeeds } from "../roomNeeds";
import { useActivity } from "../runs";
import type { Me } from "../types";
import { Icon } from "./Icon";
import { Link } from "./Link";
import { t } from "../i18n";

type Props = { me: Me; path: string; onChats: () => void; onLogout: () => void };

/** Tab-Leiste auf dem Handy (nur unter 800 px sichtbar): die Orte, die man ständig braucht, mit dem Daumen erreichbar. */
export function BottomNav({ me, path, onChats, onLogout }: Props) {
  const { needs } = useActivity();
  const { needs: roomNeeds } = useRoomNeeds();
  const wissen = useKnowledgeProviders().length > 0;
  const [more, setMore] = useState(false);
  useEffect(() => setMore(false), [path]);
  useEffect(() => {
    if (!more) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMore(false); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [more]);

  const tab = (to: string, label: string, icon: string, count?: number) => (
    <Link to={to} className={path === to ? "on" : undefined} aria-current={path === to ? "page" : undefined}>
      <span className="ti"><Icon name={icon} size={20} />{count ? <span className="ct" aria-label={`${count} offen`}>{count}</span> : null}</span>
      {label}
    </Link>
  );

  return (
    <>
      {more && <div className="scrim more-scrim" onClick={() => setMore(false)} aria-hidden />}
      {more && (
        <div className="sheet" role="dialog" aria-label={t("Mehr")}>
          <Link to="/hosts"><Icon name="server" size={18} />{t("Hosts")}</Link>
          <Link to="/assistant"><Icon name="spark" size={18} />{t("Assistent")}</Link>
          <Link to="/rooms"><Icon name="orbit" size={18} />{t("Räume")}{roomNeeds.length > 0 && <span className="ct" aria-label={`${roomNeeds.length} offen`}>{roomNeeds.length}</span>}</Link>
          <Link to="/memory"><Icon name="memory" size={18} />{t("Gedächtnis")}</Link>
          {wissen && <Link to="/knowledge"><Icon name="file" size={18} />{t("Wissen")}</Link>}
          <Link to="/providers"><Icon name="coin" size={18} />{t("Anbieter")}</Link>
          <Link to="/system"><Icon name="shield" size={18} />{t("System")}</Link>
          <Link to="/settings"><Icon name="sliders" size={18} />{t("Darstellung")}</Link>
          <span className="soon" aria-disabled="true"><Icon name="kanban" size={18} />{t("Kanban")}<span className="tag">{t("PHASE 3")}</span></span>
          {me.auth_mode === "oidc" && <button type="button" onClick={onLogout}><Icon name="power" size={18} />{t("Abmelden")}</button>}
        </div>
      )}
      <nav className="tabbar" aria-label={t("Hauptnavigation")}>
        {tab("/", t("Cockpit"), "grid")}
        {tab("/inbox", t("Inbox"), "inbox", needs.length + roomNeeds.length)}
        <button type="button" onClick={onChats}><span className="ti"><Icon name="chat" size={20} /></span>{t("Chats")}</button>
        <button type="button" className={more ? "on" : undefined} aria-expanded={more} onClick={() => setMore(!more)}>
          <span className="ti"><Icon name="menu" size={20} /></span>{t("Mehr")}
        </button>
      </nav>
    </>
  );
}
