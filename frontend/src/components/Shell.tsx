import { useEffect, useState, type ReactNode } from "react";
import { useAgentRef, useResolvedAgent } from "../hosts";
import { ShellContext, useSessions } from "../shell";
import type { Me } from "../types";
import { sameAgent, type Page } from "../router";
import { useActivity, useRunStore } from "../runs";
import { BgFx } from "./BgFx";
import { Icon } from "./Icon";
import { Sidebar } from "./Sidebar";
import { Rail } from "./chat/Rail";
import { SessionColumn } from "./chat/SessionColumn";

type Props = { me: Me; path: string; page: Page; onLogout: () => void; children: ReactNode };

function crumbs(page: Page): string[] {
  switch (page.name) {
    case "cockpit": return ["cockpit"];
    case "inbox": return ["inbox"];
    case "hosts": return ["hosts"];
    case "settings": return ["darstellung"];
    case "agent": return [page.ref.host, page.ref.runtime, page.ref.agent, page.sessionId ? `${page.module}/${page.sessionId}` : page.module];
    default: return [];
  }
}

export function Shell({ me, path, page, onLogout, children }: Props) {
  const [menu, setMenu] = useState(false);
  const active = useAgentRef(page.name === "agent" ? page.ref : undefined);
  // Sessions nur von erreichbaren Runtimes holen: Offline-Hosts würden sonst bei jedem Öffnen Fehler melden.
  const resolved = useResolvedAgent(active);
  const { sessions, loading, refresh } = useSessions(resolved?.runtimeOnline ? active : undefined);
  // Ein Run des geöffneten Agents ist zu Ende: neue Session und neuer Titel erscheinen in der Liste.
  const store = useRunStore();
  useEffect(() => store.onRunEnd((a) => { if (sameAgent(a, active)) refresh(); }), [store, active, refresh]);
  // Der Tab zeigt, dass etwas auf die Person wartet.
  const { needs } = useActivity();
  useEffect(() => { document.title = needs.length ? `(${needs.length}) Hermes` : "Hermes"; }, [needs.length]);
  const trail = crumbs(page);
  const sessionId = page.name === "agent" ? page.sessionId : undefined;
  const sidebar = (
    <Sidebar
      me={me} path={path} active={active} sessionId={sessionId}
      sessions={sessions} sessionsLoading={loading} open={menu} onClose={() => setMenu(false)} onLogout={onLogout}
    />
  );
  const value = { openMenu: () => setMenu(true), sessions, sessionsLoading: loading, refreshSessions: refresh };

  // Chat: schmale Leiste, Session-Spalte, Verlauf und Inspector füllen die Höhe. Auf schmalen Schirmen ersetzt die Schublade Leiste und Spalte.
  if (page.name === "agent" && page.module === "chat" && active && resolved) {
    return (
      <ShellContext.Provider value={value}>
        <div className="ch">
          <BgFx />
          <Rail me={me} active={active} onLogout={onLogout} />
          <SessionColumn agent={active} label={resolved.label} runtimeLabel={resolved.runtimeLabel} sessionId={sessionId} />
          {children}
          {sidebar}
        </div>
      </ShellContext.Provider>
    );
  }

  return (
    <ShellContext.Provider value={value}>
      <div className="shell">
        {sidebar}
        <div className="main">
          <BgFx />
          <div className="top">
            <button type="button" className="btn btn-i btn-g menu-btn" aria-label="Menü" onClick={() => setMenu(true)}><Icon name="menu" size={18} /></button>
            <nav className="crumb" aria-label="Pfad">
              <span>{location.hostname}</span>
              {trail.map((c, i) => (
                <span key={`${c}-${i}`} className="row" style={{ gap: 8 }}>
                  <Icon name="chevr" size={12} />
                  {i === trail.length - 1 ? <b>{c}</b> : <span>{c}</span>}
                </span>
              ))}
            </nav>
          </div>
          {children}
        </div>
      </div>
    </ShellContext.Provider>
  );
}
