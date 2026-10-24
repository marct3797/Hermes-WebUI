import { PageHead } from "../components/PageHead";

// Platzhalter: das zuständige Arbeitspaket ersetzt diese Datei vollständig.
export function JobsPage({ host }: { host?: string }) {
  return <main className="page"><PageHead title="Zeitpläne" sub={host ?? "in Arbeit"} /></main>;
}
