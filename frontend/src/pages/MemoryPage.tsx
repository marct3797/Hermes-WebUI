import { useState } from "react";
import { api } from "../api";
import { DiagChecks } from "../components/DiagChecks";
import { Icon } from "../components/Icon";
import { GraphView } from "../components/memory/GraphView";
import { EntitiesView, ItemsView, ModelsView, ReflectView, SearchView, StatsView } from "../components/memory/Views";
import { PageHead } from "../components/PageHead";
import type { DiagReport, MemProvider } from "../types";
import { useAsync } from "../useAsync";

/** Welche Ansicht ein Anbieter kann, steht in seinen Fähigkeiten. Die Reihenfolge ist die der Tabs. */
const TABS: Array<{ id: string; label: string; needs: string }> = [
  { id: "stats", label: "Übersicht", needs: "stats" },
  { id: "items", label: "Fakten", needs: "items" },
  { id: "search", label: "Suche", needs: "search" },
  { id: "graph", label: "Graph", needs: "graph" },
  { id: "entities", label: "Entitäten", needs: "entities" },
  { id: "models", label: "Modelle", needs: "models" },
  { id: "reflect", label: "Fragen", needs: "reflect" },
];

function View({ tab, provider }: { tab: string; provider: string }) {
  switch (tab) {
    case "stats": return <StatsView provider={provider} />;
    case "items": return <ItemsView provider={provider} />;
    case "search": return <SearchView provider={provider} />;
    case "graph": return <GraphView provider={provider} />;
    case "entities": return <EntitiesView provider={provider} />;
    case "models": return <ModelsView provider={provider} />;
    case "reflect": return <ReflectView provider={provider} />;
    default: return null;
  }
}

/**
 * Gedächtnis: liest, was ein Gedächtnis-Anbieter (Hindsight, später weitere) über die Agents weiß. Die Anbieter stehen in der
 * Konfiguration des BFF; jede Ansicht erscheint nur, wenn der Anbieter sie kann. Die Seite schreibt nichts.
 */
export function MemoryPage() {
  const list = useAsync(() => api.memoryProviders(), []);
  const [chosen, setChosen] = useState<string>();
  const [tabId, setTabId] = useState<string>();
  const [report, setReport] = useState<DiagReport>();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string>();

  const providers: MemProvider[] = list.data?.providers ?? [];
  const provider = providers.find((p) => p.id === chosen) ?? providers[0];
  const tabs = provider ? TABS.filter((t) => provider.capabilities.includes(t.needs)) : [];
  const tab = tabs.find((t) => t.id === tabId) ?? tabs[0];

  const check = async () => {
    if (!provider) return;
    setChecking(true);
    setCheckError(undefined);
    try { setReport(await api.memoryDiagnose(provider.id)); } catch (e) { setCheckError((e as Error).message); } finally { setChecking(false); }
  };

  return (
    <main className="page">
      <PageHead title="Gedächtnis" sub={provider ? `${provider.label} · Bank ${provider.bank}` : undefined}>
        {providers.length > 1 && (
          <label className="row" style={{ gap: 6 }}>
            <span className="lbl">Anbieter</span>
            <select className="field field-line" value={provider?.id} onChange={(e) => { setChosen(e.target.value); setTabId(undefined); setReport(undefined); }} aria-label="Anbieter">
              {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
        )}
        {provider && <button type="button" className="btn btn-s" onClick={() => void check()} disabled={checking}><Icon name="refresh" size={14} />{checking ? "Prüfe…" : "Verbindung prüfen"}</button>}
      </PageHead>

      {list.error && <p className="banner" role="alert"><Icon name="alert" />Gedächtnis nicht ladbar: {list.error}</p>}
      {list.loading && <p className="muted">Lade…</p>}
      {list.data?.config_error && <p className="banner" role="alert"><Icon name="alert" />Die Gedächtnis-Konfiguration ist fehlerhaft: {list.data.config_error}</p>}
      {list.data && providers.length === 0 && !list.data.config_error && (
        <div className="empty">
          <h2>Kein Gedächtnis-Anbieter eingerichtet</h2>
          <p className="muted">Anbieter stehen in der Datei, auf die <code>HERMES_WEBUI_MEMORY_FILE</code> zeigt (Vorlage: <code>backend/memory.example.json</code>).</p>
        </div>
      )}

      {checkError && <p className="error small" role="alert">{checkError}</p>}
      {report && <section className="card diag-card" aria-label="Verbindungsprüfung"><DiagChecks checks={report.checks} /></section>}

      {provider && tab && (
        <>
          <div className="tabs" role="tablist" aria-label="Ansichten">
            {tabs.map((t) => (
              <button key={t.id} type="button" role="tab" className={`tab${t.id === tab.id ? " on" : ""}`} aria-selected={t.id === tab.id} onClick={() => setTabId(t.id)}>{t.label}</button>
            ))}
          </div>
          <div className="mem-body" role="tabpanel" aria-label={tab.label}>
            <View key={`${provider.id}/${tab.id}`} tab={tab.id} provider={provider.id} />
          </div>
        </>
      )}
    </main>
  );
}
