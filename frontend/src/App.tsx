import { useEffect, useMemo, useState } from "react";
import { ApiError, api, page as browser } from "./api";
import { Shell } from "./components/Shell";
import { HostsProvider } from "./hosts";
import { RunsProvider } from "./runs";
import { UiProvider } from "./ui";
import { AgentPage } from "./pages/AgentPage";
import { HostsPage } from "./pages/HostsPage";
import { CockpitPage } from "./pages/CockpitPage";
import { InboxPage } from "./pages/InboxPage";
import { NotFoundPage } from "./pages/Placeholders";
import { navigate, parsePath, usePath } from "./router";
import type { Me } from "./types";

export function App() {
  const path = usePath();
  const page = useMemo(() => parsePath(path), [path]);
  const [me, setMe] = useState<Me>();
  const [error, setError] = useState<ApiError | Error>();

  useEffect(() => {
    api.me().then(setMe).catch(setError);
  }, []);

  useEffect(() => {
    if (page.name === "redirect") navigate(page.to, true);
  }, [page]);

  if (error) {
    // 401 leitet api.ts zur Anmeldung weiter; alles andere ist ein Ausfall des BFF.
    const login = error instanceof ApiError && error.status === 401;
    return (
      <main className="center">
        <p className={login ? "muted" : "error"} role={login ? "status" : "alert"}>
          {login ? "Weiterleitung zur Anmeldung…" : `Das BFF ist nicht erreichbar: ${error.message}`}
        </p>
      </main>
    );
  }
  if (!me) return <main className="center"><p className="muted">Lade…</p></main>;

  const logout = () => { api.logout().finally(() => browser.assign("/")); };

  return (
    <UiProvider>
    <HostsProvider>
    <RunsProvider>
      <Shell me={me} path={path} page={page} onLogout={logout}>
        {(() => {
          switch (page.name) {
            case "cockpit": return <CockpitPage />;
            case "inbox": return <InboxPage />;
            case "hosts": return <HostsPage />;
            case "agent": return <AgentPage page={page} />;
            case "redirect": return null;
            case "notfound": return <NotFoundPage />;
          }
        })()}
      </Shell>
    </RunsProvider>
    </HostsProvider>
    </UiProvider>
  );
}
