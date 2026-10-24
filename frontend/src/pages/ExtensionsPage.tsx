import { PageHead } from "../components/PageHead";

// Platzhalter: das zuständige Arbeitspaket ersetzt diese Datei vollständig.
export function ExtensionsPage({ host }: { host?: string }) {
  return <main className="page"><PageHead title="Erweiterungen" sub={host ?? "in Arbeit"} /></main>;
}
