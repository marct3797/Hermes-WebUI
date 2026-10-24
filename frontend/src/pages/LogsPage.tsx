import { PageHead } from "../components/PageHead";

// Platzhalter: das zuständige Arbeitspaket ersetzt diese Datei vollständig.
export function LogsPage({ host }: { host?: string }) {
  return <main className="page"><PageHead title="Logs" sub={host ?? "in Arbeit"} /></main>;
}
