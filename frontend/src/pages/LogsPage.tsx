import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "../components/Icon";
import { PageHead } from "../components/PageHead";
import { useHosts } from "../hosts";
import { levels, mergeLines } from "../logLines";
import { LOG_COMPONENTS, LOG_FILES, LOG_LEVELS, logsApi, type LogQuery } from "../opsApi";

const LIVE_MS = 3000;
const LINES = [100, 200, 500];

/** Logs eines Hosts über das Dashboard: Datei, Zeilenzahl, Stufe, Komponente, Suche, Live-Modus. Der Server schwärzt Geheimnisse. */
export function LogsPage({ host }: { host?: string }) {
  const registry = useHosts();
  const [chosenHost, setChosenHost] = useState<string>();
  const [chosenProfile, setChosenProfile] = useState<string>();
  const [q, setQ] = useState({ file: "agent", lines: 200, level: "ALL", component: "all", search: "" });
  const [draft, setDraft] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [state, setState] = useState<{ loading: boolean; error?: string; truncated?: boolean; loaded?: boolean }>({ loading: false });
  const [live, setLive] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [follow, setFollow] = useState(true);
  const [note, setNote] = useState<string>();
  const [rev, setRev] = useState(0);
  const view = useRef<HTMLPreElement>(null);
  const hostId = host ?? chosenHost ?? registry.hosts?.[0]?.id;
  const known = registry.hosts?.find((h) => h.id === hostId);
  const profiles = known?.runtimes.find((r) => r.id === "hermes")?.agents ?? known?.runtimes[0]?.agents ?? [];
  const profile = profiles.find((p) => p.id === chosenProfile)?.id ?? profiles[0]?.id;
  const query: LogQuery = { ...q, profile };

  const key = JSON.stringify([hostId, query, rev]);
  const queryRef = useRef(query); queryRef.current = query;
  const fetchOnce = useCallback(async (merge: boolean, signal: AbortSignal) => {
    if (!hostId) return;
    try {
      const r = await logsApi.get(hostId, queryRef.current, signal);
      setLines((old) => (merge ? mergeLines(old, r.lines) : r.lines));
      setState({ loading: false, truncated: r.truncated, loaded: true });
    } catch (e) {
      if (signal.aborted) return;
      setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
    }
  }, [hostId]);

  useEffect(() => {  // Filter oder Neuladen: komplett neu holen
    const ac = new AbortController();
    setState((s) => ({ ...s, loading: true, error: undefined }));
    void fetchOnce(false, ac.signal);
    return () => ac.abort();
  }, [key, fetchOnce]);
  useEffect(() => {  // Live: alle 3 s das Ende holen und anhängen
    if (!live) return;
    let ac = new AbortController();
    const id = setInterval(() => { ac.abort(); ac = new AbortController(); void fetchOnce(true, ac.signal); }, LIVE_MS);
    return () => { clearInterval(id); ac.abort(); };
  }, [live, key, fetchOnce]);
  useEffect(() => { if (follow && view.current) view.current.scrollTop = view.current.scrollHeight; }, [lines, follow]);

  const lv = levels(lines);
  const apply = (e: FormEvent) => { e.preventDefault(); setQ({ ...q, search: draft.trim() }); };
  const set = (patch: Partial<typeof q>) => setQ({ ...q, ...patch });
  const text = lines.join("\n");
  const copy = async () => { try { await navigator.clipboard.writeText(text); setNote(`${lines.length.toLocaleString("de-DE")} Zeilen kopiert.`); } catch { setNote("Kopieren nicht möglich."); } };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text + "\n"], { type: "text/plain" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${q.file}.log` });
    a.click(); URL.revokeObjectURL(url);
    setNote(`${lines.length.toLocaleString("de-DE")} Zeilen heruntergeladen.`);
  };
  const sel = (label: string, value: string | number, opts: readonly (string | number)[], on: (v: string) => void) => (
    <label className="col"><span className="lbl">{label}</span>
      <select className="field field-line" value={value} onChange={(e) => on(e.target.value)}>{opts.map((o) => <option key={o} value={o}>{o}</option>)}</select></label>
  );
  return (
    <main className="page">
      <PageHead title="Logs" sub={known && profile ? `${known.label} · ${profile}` : undefined}>
        {!host && registry.hosts && registry.hosts.length > 1 && (
          <label className="row" style={{ gap: 6 }}><span className="lbl">Host</span>
            <select className="field field-line" aria-label="Host" value={hostId} onChange={(e) => { setChosenHost(e.target.value); setChosenProfile(undefined); }}>
              {registry.hosts.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}</select></label>)}
      </PageHead>
      {registry.error && <p className="banner" role="alert">{registry.error}</p>}
      {registry.hosts && !known && <p className="empty">{host ? "Host nicht in der Registry vorhanden." : "Keine Hosts konfiguriert."}</p>}
      {known && (
        <>
          <form className="logs-bar" onSubmit={apply} aria-label="Logfilter">
            {sel("Datei", q.file, LOG_FILES, (v) => set({ file: v }))}
            {profiles.length > 1 && <label className="col"><span className="lbl">Profil</span>
              <select className="field field-line" value={profile} onChange={(e) => setChosenProfile(e.target.value)}>{profiles.map((p) => <option key={p.id} value={p.id}>{p.label || p.id}</option>)}</select></label>}
            {sel("Zeilen", q.lines, LINES, (v) => set({ lines: Number(v) }))}
            {sel("Stufe", q.level, LOG_LEVELS, (v) => set({ level: v }))}
            {sel("Komponente", q.component, LOG_COMPONENTS, (v) => set({ component: v }))}
            <label className="col grow"><span className="lbl">Volltextsuche</span>
              <input className="field field-line" value={draft} maxLength={200} onChange={(e) => setDraft(e.target.value)} placeholder="Text in Zeilen suchen" /></label>
            <button type="submit" className="btn btn-s">Suchen</button>
          </form>
          <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <button type="button" className="btn btn-s" disabled={state.loading} onClick={() => setRev((n) => n + 1)}><Icon name="refresh" size={14} />Neu laden</button>
            <button type="button" className={`btn btn-s${live ? " btn-p" : ""}`} aria-pressed={live} onClick={() => setLive(!live)}>{live ? "Live pausieren" : "Live starten"}</button>
            <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /><span>Zeilen umbrechen</span></label>
            <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /><span>Automatisch nach unten</span></label>
            <span className="grow" />
            <button type="button" className="btn btn-s" disabled={lines.length === 0} onClick={() => void copy()}><Icon name="copy" size={14} />Kopieren</button>
            <button type="button" className="btn btn-s" disabled={lines.length === 0} onClick={download}>Herunterladen</button>
          </div>
          <p className="hint" role="status" style={{ margin: "0 0 8px" }}>
            {state.loading && !state.loaded ? "Lade…" : `${lines.length.toLocaleString("de-DE")} Zeilen`}{live && <span className="logs-live"> · Live: alle 3 Sekunden aktualisiert</span>}
            {state.truncated && " · gekürzt auf die neuesten Zeilen"} · Geheimnisse sind serverseitig geschwärzt{note ? ` · ${note}` : ""}
          </p>
          {state.error && <p className="banner" role="alert"><Icon name="alert" /><span>Logs nicht ladbar: {state.error}</span></p>}
          {state.loaded && lines.length === 0 && !state.error && <p className="panel-empty">Keine Zeilen für diese Auswahl. Filter lockern oder eine andere Datei wählen.</p>}
          {lines.length > 0 && (
            <pre ref={view} className={`logs-view${wrap ? " wrap" : ""}`} tabIndex={0} aria-label="Logzeilen">
              {lines.map((l, i) => <span key={i} className={`logs-line${lv[i] ? ` logs-${lv[i]}` : ""}`}>{l || " "}</span>)}
            </pre>)}
        </>)}
    </main>
  );
}
