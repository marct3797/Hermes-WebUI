import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { ApiError, api, page as browser } from "./api";
import { Shell } from "./components/Shell";
import { PageBoundary } from "./components/PageBoundary";
import { HostsProvider } from "./hosts";
import { RoomNeedsProvider } from "./roomNeeds";
import { RunsProvider } from "./runs";
import { UiProvider } from "./ui";
import { AgentPage } from "./pages/AgentPage";
import { CockpitPage } from "./pages/CockpitPage";
import { NotFoundPage } from "./pages/Placeholders";
import { parsePath, usePath } from "./router";
import type { Me } from "./types";

// Seltene oder schwere Seiten laden erst beim Öffnen (kleineres Startbundle); AgentPage und Cockpit bleiben im Start.
const HostsPage = lazy(() => import("./pages/HostsPage").then(m => ({ default: m.HostsPage })));
const InboxPage = lazy(() => import("./pages/InboxPage").then(m => ({ default: m.InboxPage })));
const MemoryPage = lazy(() => import("./pages/MemoryPage").then(m => ({ default: m.MemoryPage })));
const ProvidersHubPage = lazy(() => import("./pages/ProvidersHubPage").then(m => ({ default: m.ProvidersHubPage })));
const RoomPage = lazy(() => import("./pages/RoomPage").then(m => ({ default: m.RoomPage })));
const RoomsPage = lazy(() => import("./pages/RoomsPage").then(m => ({ default: m.RoomsPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then(m => ({ default: m.SettingsPage })));
const SystemPage = lazy(() => import("./pages/SystemPage").then(m => ({ default: m.SystemPage })));
const OperationsPage = lazy(() => import("./pages/OperationsPage").then(m => ({ default: m.OperationsPage })));
const TerminalPage = lazy(() => import("./pages/TerminalPage").then(m => ({ default: m.TerminalPage })));
const WorkspacePage = lazy(() => import("./pages/WorkspacePage").then(m => ({ default: m.WorkspacePage })));

export function App() {
  const path = usePath();
  const page = useMemo(() => parsePath(path), [path]);
  const [me, setMe] = useState<Me>();
  const [error, setError] = useState<ApiError | Error>();
  useEffect(() => { api.me().then(setMe).catch(setError); }, []);

  if (error) {
    const login = error instanceof ApiError && error.status === 401;
    return <main className="center"><p className={login ? "muted" : "error"} role={login ? "status" : "alert"}>
      {login ? "Weiterleitung zur Anmeldung…" : `Das BFF ist nicht erreichbar: ${error.message}`}
    </p></main>;
  }
  if (!me) return <main className="center"><p className="muted">Lade…</p></main>;
  const logout = () => {
    try {
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const key = sessionStorage.key(i);
        if (key && (key === "hermes-known-runs" || key === "hermes-run-notifications" || key.startsWith("hermes-terminal"))) sessionStorage.removeItem(key);
      }
    } catch { /* ohne Speicher keine Bereinigung nötig */ }
    api.logout().finally(() => browser.assign("/"));
  };
  return (
    <UiProvider><HostsProvider><RunsProvider><RoomNeedsProvider>
      <Shell me={me} path={path} page={page} onLogout={logout}>
        <PageBoundary key={path}>
          <Suspense fallback={<main className="page" aria-busy="true"><p className="muted" role="status">Lade Ansicht…</p></main>}>
            {(() => {
              switch (page.name) {
                case "cockpit": return <CockpitPage />;
                case "inbox": return <InboxPage />;
                case "hosts": return <HostsPage />;
                case "settings": return <SettingsPage />;
                case "system": return <SystemPage />;
                case "memory": return <MemoryPage />;
                case "providers": return <ProvidersHubPage />;
                case "rooms": return <RoomsPage />;
                case "room": return <RoomPage key={page.id} roomId={page.id} />;
                case "agent": return <AgentPage page={page} />;
                case "operations": return <OperationsPage section={page.section} host={page.host} />;
                case "terminal": return <TerminalPage host={page.host} />;
                case "workspace": return <WorkspacePage host={page.host} />;
                case "notfound": return <NotFoundPage />;
              }
            })()}
          </Suspense>
        </PageBoundary>
      </Shell>
    </RoomNeedsProvider></RunsProvider></HostsProvider></UiProvider>
  );
}
