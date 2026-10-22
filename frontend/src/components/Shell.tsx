import { useState, type ReactNode } from "react";
import { useAgentRef, useResolvedAgent } from "../hosts";
import { useSessions, ShellContext } from "../shell";
import type { Me } from "../types";
import { type Page } from "../router";
import { Icon } from "./Icon";
import { Sidebar } from "./Sidebar";

type Props = { me: Me; path: string; page: Page; onLogout: () => void; children: ReactNode };

function crumbs(page: Page): string[] {
  switch (page.name) {
    case "cockpit": return ["cockpit"];
    case "inbox": return ["inbox"];
    case "hosts": return ["hosts"];
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
  const trail = crumbs(page);
  return (
    <ShellContext.Provider value={{ openMenu: () => setMenu(true), sessions, sessionsLoading: loading, refreshSessions: refresh }}>
      <div className={`shell${page.name === "agent" ? " fixed" : ""}`}>
        <Sidebar
          me={me} path={path} active={active} sessionId={page.name === "agent" ? page.sessionId : undefined}
          sessions={sessions} sessionsLoading={loading} open={menu} onClose={() => setMenu(false)} onLogout={onLogout}
        />
        <div className="main">
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
