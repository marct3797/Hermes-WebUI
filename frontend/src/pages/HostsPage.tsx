import { Link } from "../components/Link";
import { PageHeader } from "../components/PageHeader";
import { Monogram, StatusDot, STATUS_LABEL } from "../components/Status";
import { useHosts } from "../hosts";
import { agentPath } from "../router";

export function HostsPage() {
  const { hosts, configError, error, refresh } = useHosts();
  return (
    <main className="page">
      <PageHeader title="Hosts">
        <button type="button" className="ghost small" onClick={refresh}>Aktualisieren</button>
      </PageHeader>
      <div className="page-body">
        {error && <p className="banner error" role="alert">Hosts nicht ladbar: {error}</p>}
        {configError && <p className="banner error" role="alert">Konfiguration: {configError}</p>}
        {!hosts && !error && <p className="muted">Lade…</p>}
        <div className="cards">
          {hosts?.map((h) => (
            <section key={h.id} className="panel host-card" aria-label={h.label}>
              <header className="host-card-head">
                <StatusDot status={h.status} />
                <h2>{h.label}</h2>
                <span className="mono tag">{h.kind === "local" ? "lokal" : "remote"}</span>
                <span className="muted small">{STATUS_LABEL[h.status]}</span>
              </header>
              <p className="muted small mono">{h.id}{h.address ? ` · ${h.address}` : ""}</p>
              {h.detail && <p className="muted small">{h.detail}</p>}
              {h.runtimes.length === 0 && <p className="muted small">Keine Runtime konfiguriert.</p>}
              {h.runtimes.map((r) => (
                <div key={r.id} className="runtime-block">
                  <p className="runtime-line">
                    <StatusDot status={r.status} />
                    <strong>{r.label}</strong>
                    {r.version && <span className="mono muted small">{r.version}</span>}
                    <span className="muted small">{r.agents.length} {r.agents.length === 1 ? "Agent" : "Agents"}</span>
                  </p>
                  <ul className="chips">
                    {r.agents.map((a) => (
                      <li key={a.id}>
                        <Link to={agentPath({ host: h.id, runtime: r.id, agent: a.id })} className="chip">
                          <Monogram name={a.label} />{a.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
