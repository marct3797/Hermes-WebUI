import { Icon } from "../components/Icon";
import { PageHead } from "../components/PageHead";
import { HostProviders } from "../components/providers/HostProviders";
import { useHosts } from "../hosts";
import { CliPanel } from "../components/providers/CliPanel";

/** Runtimes, die ihre Anbieter über das Dashboard der Maschine führen. Andere Runtimes haben hier nichts einzustellen. */
const WITH_PROVIDERS = new Set(["hermes"]);

/**
 * Hauptseite „Anbieter“: je Host und je Profil auf dem Host den Anbieter und das Modell bestimmen, dazu die Zugänge, die auf dem Host
 * selbst laufen (Codex, Claude, OpenCode Go). Die Keys und die Nutzung eines einzelnen Profils stehen unter dem Agent.
 */
export function ProvidersHubPage() {
  const { hosts, error, refresh } = useHosts();
  const entries = (hosts ?? []).flatMap((h) => h.runtimes.filter((r) => WITH_PROVIDERS.has(r.id)).map((r) => ({ host: h, runtime: r })));
  return (
    <main className="page">
      <PageHead title="Anbieter" sub={hosts ? `${entries.length} ${entries.length === 1 ? "Host" : "Hosts"}` : undefined}>
        <button type="button" className="btn btn-s" onClick={refresh}><Icon name="refresh" size={14} />Aktualisieren</button>
      </PageHead>
      {error && <p className="banner" role="alert"><Icon name="alert" />Hosts nicht ladbar: {error}</p>}
      {!hosts && !error && <p className="muted">Lade…</p>}
      {hosts && entries.length === 0 && <p className="panel-empty">Kein Host mit einer Hermes-Runtime eingerichtet.</p>}
      <div className="hub-list">
        {entries.map(({ host, runtime }) => <HostProviders key={`${host.id}/${runtime.id}`} host={host} runtime={runtime} />)}
      </div>

      <CliPanel />
    </main>
  );
}
