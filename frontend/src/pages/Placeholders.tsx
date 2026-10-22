import { Icon } from "../components/Icon";
import { Link } from "../components/Link";
import { PageHead } from "../components/PageHead";
import { Sigil } from "../components/Sigil";
import { StatusDot, STATUS_LABEL } from "../components/Status";
import { useHosts } from "../hosts";
import { agentPath } from "../router";
import { sigilFor, useUi } from "../ui";

/** Startseite. Block 3 ersetzt sie durch das Cockpit mit Zustand, offenen Freigaben und letzter Aktivität je Agent. */
export function CockpitPage() {
  const { hosts } = useHosts();
  const { sigils } = useUi();
  const agents = hosts?.reduce((n, h) => n + h.runtimes.reduce((m, r) => m + r.agents.length, 0), 0);
  return (
    <main className="page">
      <PageHead title="Alle Agents" sub={hosts ? `${hosts.length} ${hosts.length === 1 ? "Host" : "Hosts"} · ${agents} Agents` : undefined} />
      {hosts?.map((h) => (
        <section key={h.id} aria-label={h.label} className="col" style={{ gap: 12 }}>
          <h2 className="row lbl" style={{ gap: 8 }}><StatusDot status={h.status} />{h.label}{h.address ? ` · ${h.address}` : ""}</h2>
          <div className="pgrid">
            {h.runtimes.flatMap((r) => r.agents.map((a) => {
              const ref = { host: h.id, runtime: r.id, agent: a.id };
              return (
                <Link key={`${h.id}/${r.id}/${a.id}`} to={agentPath(ref)} className="card pcard simple">
                  <span className="row" style={{ gap: 12 }}>
                    <Sigil name={a.label} config={sigilFor(sigils, ref)} size="l" />
                    <span className="col grow" style={{ gap: 2 }}>
                      <span className="nm trunc">{a.label}</span>
                      <span className="mono t3 small trunc">{h.id}/{r.id}</span>
                    </span>
                  </span>
                  <span className="tag" style={{ alignSelf: "flex-start" }}>{STATUS_LABEL[r.status] ?? r.status}</span>
                </Link>
              );
            }))}
          </div>
        </section>
      ))}
    </main>
  );
}

/** „Braucht dich“: Freigaben, Rückfragen und Reviews aller Agents. Kommt mit Block 3. */
export function InboxPage() {
  return (
    <main className="page">
      <PageHead title="Inbox" />
      <div className="empty">
        <Icon name="inbox" size={20} />
        <h2>Braucht dich</h2>
        <p className="muted">Freigaben und Rückfragen aller Agents sammeln sich hier. Das Modul folgt; offene Freigaben erscheinen bis dahin im Chat des jeweiligen Agents.</p>
      </div>
    </main>
  );
}

export function NotFoundPage({ what = "Diese Seite" }: { what?: string }) {
  return (
    <main className="page">
      <PageHead title="Nicht gefunden" />
      <div className="empty">
        <h2>{what} gibt es nicht</h2>
        <p className="muted"><Link to="/hosts" className="inline-link">Zur Host-Übersicht</Link></p>
      </div>
    </main>
  );
}

export function ModulePage({ module }: { module: string }) {
  return (
    <main className="page">
      <PageHead title={module} />
      <div className="empty">
        <h2>Dieses Modul folgt</h2>
        <p className="muted">Je nach Runtime kommen weitere Module (Sessions, Memory, Skills …) in späteren Phasen.</p>
      </div>
    </main>
  );
}
