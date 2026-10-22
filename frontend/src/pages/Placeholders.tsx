import { Link } from "../components/Link";
import { PageHeader } from "../components/PageHeader";
import { Monogram, StatusDot } from "../components/Status";
import { useHosts } from "../hosts";
import { agentPath } from "../router";

/** Startseite. Phase 1 füllt sie mit Karten je Agent (Zustand, offene Freigaben, letzte Aktivität). */
export function CockpitPage() {
  const { hosts } = useHosts();
  return (
    <main className="page">
      <PageHeader title="Cockpit" />
      <div className="page-body">
        <p className="muted">Hier entstehen die Karten je Agent: Zustand, offene Freigaben und letzte Aktivität. Bis dahin der direkte Weg:</p>
        <div className="cards">
          {hosts?.flatMap((h) => h.runtimes.flatMap((r) => r.agents.map((a) => (
            <Link key={`${h.id}/${r.id}/${a.id}`} to={agentPath({ host: h.id, runtime: r.id, agent: a.id })} className="panel agent-card">
              <Monogram name={a.label} />
              <span className="agent-card-name">{a.label}</span>
              <span className="muted small mono">{h.id} · {r.id}</span>
              <StatusDot status={r.status} />
            </Link>
          ))))}
        </div>
      </div>
    </main>
  );
}

/** „Braucht dich“: Freigaben, Rückfragen und Reviews aller Agents. Kommt in Phase 1. */
export function InboxPage() {
  return (
    <main className="page">
      <PageHeader title="Inbox" />
      <div className="page-body">
        <div className="empty">
          <h2>Braucht dich</h2>
          <p className="muted">Freigaben und Rückfragen aller Agents sammeln sich hier. Das Modul folgt in Phase 1; offene Freigaben erscheinen bis dahin im Chat des jeweiligen Agents.</p>
        </div>
      </div>
    </main>
  );
}

export function NotFoundPage({ what = "Diese Seite" }: { what?: string }) {
  return (
    <main className="page">
      <PageHeader title="Nicht gefunden" />
      <div className="page-body">
        <div className="empty">
          <h2>{what} gibt es nicht</h2>
          <p className="muted"><Link to="/hosts" className="inline-link">Zur Host-Übersicht</Link></p>
        </div>
      </div>
    </main>
  );
}

export function ModulePage({ module }: { module: string }) {
  return (
    <main className="page">
      <PageHeader title={module} />
      <div className="page-body">
        <div className="empty">
          <h2>Dieses Modul folgt</h2>
          <p className="muted">Je nach Runtime kommen weitere Module (Sessions, Memory, Skills …) in späteren Phasen.</p>
        </div>
      </div>
    </main>
  );
}
