import { useState } from "react";
import { api } from "../api";
import { DiagChecks } from "../components/DiagChecks";
import { Icon } from "../components/Icon";
import { GraphView, readGraphQuery, type GraphInit } from "../components/memory/GraphView";
import { EntitiesView, ItemsView, ModelsView, ReflectView, SearchView, StatsView, type Nav } from "../components/memory/Views";
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

/** Womit eine Ansicht geöffnet wird, wenn man aus einer anderen hierher springt. */
type Focus = { entity?: string; q?: string };

function View({ tab, provider, nav, focus, graph }: { tab: string; provider: string; nav: Nav; focus: Focus; graph: GraphInit }) {
  switch (tab) {
    case "stats": return <StatsView provider={provider} nav={nav} />;
    case "items": return <ItemsView provider={provider} nav={nav} initialQuery={focus.q} />;
    case "search": return <SearchView provider={provider} nav={nav} />;
    case "graph": return <GraphView provider={provider} initial={graph} />;
    case "entities": return <EntitiesView provider={provider} nav={nav} initial={focus.entity} />;
    case "models": return <ModelsView provider={provider} />;
    case "reflect": return <ReflectView provider={provider} />;
    default: return null;
  }
}

/**
 * Gedächtnis: liest, was ein Gedächtnis-Anbieter (Hindsight, später weitere) über die Agents weiß. Die Anbieter stehen in der
 * Konfiguration des BFF; jede Ansicht erscheint nur, wenn der Anbieter sie kann. Fakten, Entitäten und Tags führen zueinander.
 * Die Seite schreibt nichts.
 */
export function MemoryPage() {
  const list = useAsync(() => api.memoryProviders(), []);
  const [chosen, setChosen] = useState<string>();
  // Eine geteilte Adresse (?tab=graph&type=…) öffnet die Seite gleich mit diesem Graphen.
  const [shared] = useState(() => readGraphQuery(window.location.search));
  const [tabId, setTabId] = useState<string | undefined>(shared.tab);
  const [focus, setFocus] = useState<Focus>({});
  const [report, setReport] = useState<DiagReport>();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string>();

  const providers: MemProvider[] = list.data?.providers ?? [];
  const provider = providers.find((p) => p.id === chosen) ?? providers[0];
  // Mentale Modelle legt man in Hindsight selbst an; solange es keine gibt, bleibt der Reiter weg.
  const models = useAsync(() => (provider?.capabilities.includes("models") ? api.memoryModels(provider.id) : Promise.resolve(undefined)), [provider?.id]);
  const noModels = !models.data || models.data.items.length === 0;
  const tabs = provider ? TABS.filter((t) => provider.capabilities.includes(t.needs) && !(t.id === "models" && noModels)) : [];
  const tab = tabs.find((t) => t.id === tabId) ?? tabs[0];

  // Sprung aus einer Ansicht in eine andere: Reiter wechseln und der Ansicht sagen, was sie zeigen soll.
  const nav: Nav = {
    entity: (name) => { setFocus({ entity: name }); setTabId("entities"); },
    facts: (q) => { setFocus({ q }); setTabId("items"); },
  };

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
            <select className="field field-line" value={provider?.id} onChange={(e) => { setChosen(e.target.value); setTabId(undefined); setFocus({}); setReport(undefined); }} aria-label="Anbieter">
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
              <button key={t.id} type="button" role="tab" className={`tab${t.id === tab.id ? " on" : ""}`} aria-selected={t.id === tab.id} onClick={() => { setFocus({}); setTabId(t.id); }}>{t.label}</button>
            ))}
          </div>
          <div className="mem-body" role="tabpanel" aria-label={tab.label}>
            <View key={`${provider.id}/${tab.id}/${focus.entity ?? ""}/${focus.q ?? ""}`} tab={tab.id} provider={provider.id} nav={nav} focus={focus} graph={shared} />
          </div>
        </>
      )}
    </main>
  );
}
