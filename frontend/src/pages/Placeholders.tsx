import { Link } from "../components/Link";
import { PageHead } from "../components/PageHead";

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
