import { Icon } from "../components/Icon";
import { PageHead } from "../components/PageHead";
import { HostProviders } from "../components/providers/HostProviders";
import { useHosts } from "../hosts";

/** Coding-CLIs, die die WebUI je Host anbindet. Hier steht, was feststeht; Abo-Zugänge laufen nicht über Hermes-Anbieter. */
const CODING_CLIS = [
  ["claude-code", "Claude Code", "Abo über die CLI auf dem Host. Die Abo-Anmeldung darf nicht in fremden Oberflächen genutzt werden, geplant ist eine Terminal-Ansicht der echten CLI."],
  ["opencode", "OpenCode", "Eigener Server auf dem Host (HTTP und Ereignisstrom), Anbieter-Keys liegen in seiner eigenen Config."],
  ["antigravity", "Antigravity", "CLI auf dem Host, Anmeldung im Terminal. Eine Programmschnittstelle ist nicht bekannt."],
  ["codex", "OpenAI Codex", "Anmeldung über ChatGPT oder Key. Hermes nutzt sie als Anbieter (Spalte „OpenAI Codex“ oben); die CLI selbst läuft auf dem Host."],
] as const;

/** Runtimes, die ihre Anbieter über das Dashboard der Maschine führen. Andere Runtimes haben hier nichts einzustellen. */
const WITH_PROVIDERS = new Set(["hermes"]);

/**
 * Hauptseite „Anbieter“: je Host und je Profil auf dem Host den Anbieter und das Modell bestimmen, dazu die Zugänge, die auf dem Host
 * selbst laufen (Codex, Claude, OpenCode Go). Die Keys und die Nutzung eines einzelnen Profils stehen unter dem Agent.
 */
export function ProvidersHubPage() {
  const { hosts, error, refresh } = useHosts();
  const installed = new Set((hosts ?? []).flatMap((h) => h.runtimes.map((r) => r.id)));
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

      <section aria-label="Coding-CLIs" className="col" style={{ gap: 10 }}>
        <span className="lbl">Coding-CLIs auf den Hosts</span>
        <ul className="prov-grid">
          {CODING_CLIS.map(([id, name, text]) => (
            <li key={id} className="card prov-card off">
              <div className="row prov-head"><b className="grow">{name}</b>{installed.has(id) ? <span className="tag tag-m">ANGEBUNDEN</span> : <span className="tag">NOCH NICHT ANGEBUNDEN</span>}</div>
              <p className="hint">{text}</p>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
