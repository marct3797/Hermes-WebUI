import { useState, type ReactNode } from "react";
import { useAgentRef, useResolvedAgent } from "../hosts";
import { useSessions, ShellContext } from "../shell";
import type { Me } from "../types";
import { type Page } from "../router";
import { Sidebar } from "./Sidebar";

type Props = { me: Me; path: string; page: Page; onLogout: () => void; children: ReactNode };

export function Shell({ me, path, page, onLogout, children }: Props) {
  const [menu, setMenu] = useState(false);
  const active = useAgentRef(page.name === "agent" ? page.ref : undefined);
  // Sessions nur von erreichbaren Runtimes holen: Offline-Hosts würden sonst bei jedem Öffnen Fehler melden.
  const resolved = useResolvedAgent(active);
  const { sessions, loading, refresh } = useSessions(resolved?.runtimeOnline ? active : undefined);
  return (
    <ShellContext.Provider value={{ openMenu: () => setMenu(true), sessions, sessionsLoading: loading, refreshSessions: refresh }}>
      <div className="app">
        <Sidebar
          me={me} path={path} active={active} sessionId={page.name === "agent" ? page.sessionId : undefined}
          sessions={sessions} sessionsLoading={loading} open={menu} onClose={() => setMenu(false)} onLogout={onLogout}
        />
        {children}
      </div>
    </ShellContext.Provider>
  );
}
