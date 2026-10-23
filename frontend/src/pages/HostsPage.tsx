import { Icon } from "../components/Icon";
import { Link } from "../components/Link";
import { PageHead } from "../components/PageHead";
import { Sigil } from "../components/Sigil";
import { StatusDot, STATUS_LABEL } from "../components/Status";
import { useHosts } from "../hosts";
import { agentPath } from "../router";
import { sigilFor, useUi } from "../ui";

export function HostsPage() {
  const { hosts, configError, error, refresh } = useHosts();
  const { sigils } = useUi();
  return (
    <main className="page">
      <PageHead title="Hosts" sub={hosts ? `${hosts.length} ${hosts.length === 1 ? "Host" : "Hosts"}` : undefined}>
        <button type="button" className="btn btn-s" onClick={refresh}><Icon name="refresh" size={14} />Aktualisieren</button>
      </PageHead>
      {error && <p className="banner" role="alert"><Icon name="alert" />Hosts nicht ladbar: {error}</p>}
      {configError && <p className="banner" role="alert"><Icon name="alert" />Konfiguration: {configError}</p>}
      {!hosts && !error && <p className="muted">Lade…</p>}
      <div className="pgrid">
        {hosts?.map((h) => (
          <section key={h.id} className={`card host-card${h.status === "online" ? "" : " err"}`} aria-label={h.label}>
            <header className="card-h">
              <StatusDot status={h.status} />
              <h2>{h.label}</h2>
              <span className="tag">{h.kind === "local" ? "lokal" : "remote"}</span>
              <span className="muted small" style={{ marginLeft: "auto" }}>{STATUS_LABEL[h.status]}</span>
            </header>
            <div className="host-body">
              <p className="mono t3 small">{h.id}{h.address ? ` · ${h.address}` : ""}</p>
              {h.detail && <p className="muted small">{h.detail}</p>}
              {h.runtimes.length === 0 && <p className="muted small">Keine Runtime konfiguriert.</p>}
              {h.runtimes.map((r) => (
                <div key={r.id} className="runtime-block">
                  <p className="row" style={{ gap: 8 }}>
                    <StatusDot status={r.status} />
                    <strong>{r.label}</strong>
                    {r.version && <span className="mono t3 small">{r.version}</span>}
                    <span className="muted small">{r.agents.length} {r.agents.length === 1 ? "Agent" : "Agents"}</span>
                  </p>
                  <ul className="chip-list">
                    {r.agents.map((a) => {
                      const ref = { host: h.id, runtime: r.id, agent: a.id };
                      return (
                        <li key={a.id} className="row" style={{ gap: 2 }}>
                          <Link to={agentPath(ref)} className="chip"><Sigil name={a.label} config={sigilFor(sigils, ref)} size="xs" />{a.label}</Link>
                          {r.id === "hermes" && <Link to={agentPath(ref, "skills")} className="btn btn-s btn-i btn-g" aria-label={`Skills von ${a.label}`} title="Skills"><Icon name="layers" size={12} /></Link>}
                          {r.id === "hermes" && <Link to={agentPath(ref, "tools")} className="btn btn-s btn-i btn-g" aria-label={`Werkzeuge von ${a.label}`} title="Werkzeuge"><Icon name="wrench" size={12} /></Link>}
                          <Link to={agentPath(ref, "profil")} className="btn btn-s btn-i btn-g" aria-label={`Profil von ${a.label} bearbeiten`} title="Profil bearbeiten"><Icon name="edit" size={12} /></Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
