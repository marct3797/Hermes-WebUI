import { PageHead } from "../components/PageHead";

// Platzhalter: das zuständige Arbeitspaket ersetzt diese Datei vollständig.
export function KanbanPage({ host }: { host?: string }) {
  return <main className="page"><PageHead title="Kanban" sub={host ?? "in Arbeit"} /></main>;
}
