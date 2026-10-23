import { useState } from "react";
import { PageHead } from "../components/PageHead";
import { Icon } from "../components/Icon";
import { useHosts } from "../hosts";
import { useAsync } from "../useAsync";
import { ContentSearch } from "../components/operations/ContentSearch";
import { enc, operationsHttp, unavailable, type Catalog, type Listing } from "../components/operations/http";
import { Jobs, Kanban, Logs, ManagedItems, Marketplaces, type Ask } from "../components/operations/Views";

export type OperationsSection = "kanban" | "jobs" | "logs" | "manage" | "marketplaces" | "search";
const titles: Record<OperationsSection, string> = { kanban: "Kanban", jobs: "Jobs", logs: "Logs", manage: "Verwaltung", marketplaces: "Marktplätze", search: "Inhaltssuche" };
const kinds = [{ id: "skills", label: "Skills" }, { id: "mcp", label: "MCP" }, { id: "plugins", label: "Plugins" }];

export function OperationsPage({ section, host }: { section: OperationsSection; host?: string }) {
  const registry = useHosts();
  const [chosen, setChosen] = useState<string>();
  const selected = host ?? chosen ?? registry.hosts?.[0]?.id;
  const known = registry.hosts?.find(item => item.id === selected);
  return <main className="page operations-page">
    <PageHead title={titles[section]} sub="Native Host-Daten · keine simulierten Ergebnisse">
      {section !== "search" && !host && registry.hosts && registry.hosts.length > 0 && <label>Host <select className="field field-line" aria-label="Host" value={selected} onChange={e => setChosen(e.target.value)}>{registry.hosts.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
    </PageHead>
    {section === "search" ? <ContentSearch /> : <>
      {registry.error && <p className="banner" role="alert">{registry.error}</p>}
      {registry.configError && <p className="banner" role="alert">Host-Konfiguration fehlerhaft: {registry.configError}</p>}
      {!registry.hosts && !registry.error && <p role="status">Hosts werden geladen…</p>}
      {registry.hosts && !known && <p className="empty">{host ? "Host nicht in der Registry vorhanden." : "Keine Hosts konfiguriert."}</p>}
      {known && <HostOperations key={`${known.id}/${section}`} host={known.id} section={section} agents={known.runtimes.find(runtime => runtime.id === "hermes")?.agents ?? []} />}
    </>}
  </main>;
}

function HostOperations({ host, section, agents }: { host: string; section: OperationsSection; agents: { id: string; label: string }[] }) {
  const [revision, setRevision] = useState(0);
  const [chosenProfile, setChosenProfile] = useState<string>();
  const [kind, setKind] = useState("skills");
  const [pending, setPending] = useState<{ label: string; url: string; body: Record<string, string>; method: string }>();
  const [writing, setWriting] = useState(false);
  const [writeError, setWriteError] = useState<string>();
  const root = `/bff/h/${enc(host)}`;
  const catalog = useAsync(() => section === "jobs" ? Promise.resolve(undefined) : operationsHttp<Catalog>(`${root}/_manage`), [host, section, revision]);
  const profiles = section === "jobs" ? agents : catalog.data?.profiles ?? [];
  const profile = profiles.find(item => item.id === chosenProfile)?.id ?? profiles[0]?.id;
  const kindPath = section === "manage" ? kind : section;
  const base = section === "jobs" ? `${root}/hermes/${enc(profile ?? "")}/jobs` : `${root}/_manage/${enc(profile ?? "")}/${kindPath}`;
  const listing = useAsync(() => profile && section !== "marketplaces" && !unavailable(catalog.data ?? {}) ? operationsHttp<Listing>(base) : Promise.resolve(undefined), [base, profile, section, revision, catalog.data]);
  const jobCapabilities = useAsync(() => section === "jobs" && profile ? operationsHttp<{ features?: string[] }>(`${root}/hermes/${enc(profile)}/status`) : Promise.resolve(undefined), [root, section, profile, revision]);
  const jobsData = listing.data && jobCapabilities.data?.features?.includes("jobs") ? { ...listing.data, actions: ["edit", "pause", "resume"] } : listing.data;
  const ask: Ask = (label, url, body, method = "POST") => { setWriteError(undefined); setPending({ label, url, body, method }); };
  const write = async () => {
    if (!pending || writing) return;
    setWriting(true);
    try {
      await operationsHttp(pending.url, { method: pending.method, body: JSON.stringify(pending.body) });
      setPending(undefined);
      setRevision(value => value + 1);
    } catch (error) { setWriteError(error instanceof Error ? error.message : "Änderung fehlgeschlagen."); }
    finally { setWriting(false); }
  };
  const error = catalog.error ?? listing.error;
  const unavailableReason = catalog.data && unavailable(catalog.data) || listing.data && unavailable(listing.data);
  const loading = catalog.loading || listing.loading;
  return <div className="ops-stack" aria-busy={loading || writing}>
    <div className="ops-toolbar">
      {profiles.length > 0 && <label>Profil <select className="field field-line" aria-label="Profil" disabled={writing || !!pending} value={profile} onChange={e => setChosenProfile(e.target.value)}>{profiles.map(item => <option key={item.id} value={item.id}>{"label" in item ? item.label as string : item.id}</option>)}</select></label>}
      <button className="btn btn-s" type="button" disabled={loading || writing || !!pending} onClick={() => setRevision(value => value + 1)}><Icon name="refresh" size={14} />Erneut laden</button>
    </div>
    {section === "manage" && <div className="tabs" aria-label="Verwaltungsbereiche">{kinds.map(item => <button type="button" className={`tab${kind === item.id ? " on" : ""}`} aria-pressed={kind === item.id} disabled={writing || !!pending} key={item.id} onClick={() => setKind(item.id)}>{item.label}</button>)}</div>}
    {loading && <p role="status">Daten werden geladen…</p>}
    {error && <p className="banner" role="alert">{error}</p>}
    {unavailableReason && <p className="banner" role="status">{unavailableReason}</p>}
    {catalog.data && !unavailableReason && !Array.isArray(catalog.data.profiles) && <p role="alert">Antwortformat nicht unterstützt: Profil-Liste fehlt.</p>}
    {!loading && !error && !unavailableReason && profiles.length === 0 && <p className="empty">Keine Profile verfügbar. Host-Daemon und Profilfreigaben prüfen.</p>}
    {catalog.data?.warnings?.map((warning, index) => <p className="banner" key={`catalog/${index}`}>{warning}</p>)}
    {listing.data?.note && <p className="banner">{listing.data.note}</p>}
    {listing.data?.truncated && section !== "logs" && <p role="status">Ausgabe gekürzt. Es werden nicht alle Einträge angezeigt.</p>}
    {listing.data?.warnings?.map((warning, index) => <p className="banner" key={index}>{warning}</p>)}
    {pending && <section className="card ops-card" role="alertdialog" aria-label="Aktion bestätigen" aria-describedby="ops-confirm-description" onKeyDown={e => { if (e.key === "Escape" && !writing) { e.preventDefault(); setPending(undefined); } }}>
      <h2>Aktion bestätigen</h2><p id="ops-confirm-description">{pending.label}</p><p className="muted">Host: {host} · Profil: {profile}. Die Änderung wird serverseitig geprüft; eine frische Anmeldung kann erforderlich sein.</p>
      <div className="ops-toolbar"><button className="btn" type="button" autoFocus disabled={writing} onClick={() => setPending(undefined)}>Abbrechen</button><button className="btn" type="button" disabled={writing} onClick={() => void write()}>{writing ? "Wird angewendet…" : "Bestätigen"}</button></div>
    </section>}
    {section === "jobs" && jobCapabilities.error && <p className="banner">Schreibfähigkeiten nicht prüfbar: {jobCapabilities.error}</p>}
    {writeError && <p className="banner" role="alert">{writeError}</p>}
    {!error && !unavailableReason && <fieldset className="ops-content" disabled={writing || !!pending}>
      {section === "marketplaces" && catalog.data && (Array.isArray(catalog.data.sources) ? <Marketplaces sources={catalog.data.sources} base={profile ? `${root}/_manage/${enc(profile)}` : undefined} ask={ask} /> : <p role="alert">Antwortformat nicht unterstützt: Quellen-Katalog fehlt.</p>)}
      {listing.data && section === "kanban" && <Kanban data={listing.data} base={base} ask={ask} />}
      {listing.data && section === "jobs" && <Jobs data={jobsData!} base={base} ask={ask} />}
      {listing.data && section === "logs" && <Logs data={listing.data} />}
      {listing.data && section === "manage" && <ManagedItems data={listing.data} base={base} ask={ask} />}
    </fieldset>}
  </div>;
}
