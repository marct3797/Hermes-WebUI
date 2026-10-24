import { PageHead } from "../components/PageHead";

// Platzhalter: das zuständige Arbeitspaket ersetzt diese Datei vollständig.
export function MarketplacePage({ host }: { host?: string }) {
  return <main className="page"><PageHead title="Marktplatz" sub={host ?? "in Arbeit"} /></main>;
}
