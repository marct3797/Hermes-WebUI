import { useMemo, useState } from "react";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { Link } from "../components/Link";
import { PageHead } from "../components/PageHead";
import { agentPath } from "../router";
import type { AgentRef, ConfigField, HermesConfig } from "../types";
import { useAsync } from "../useAsync";

type Draft = Record<string, unknown>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Ein Eingabefeld passend zum Typ. Listen sind JSON; ungültiger Text bleibt im Feld und sperrt das Speichern. */
function Editor({ field, value, onChange, onInvalid }: { field: ConfigField; value: unknown; onChange: (v: unknown) => void; onInvalid: (key: string, bad: boolean) => void }) {
  const [text, setText] = useState(() => (field.type === "list" ? JSON.stringify(value ?? [], null, 2) : ""));
  const [bad, setBad] = useState(false);
  const id = `cfg-${field.key}`;
  if (field.type === "boolean") return <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
  if (field.type === "select") return <select id={id} className="pf-in" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>{(field.options ?? []).map((o) => <option key={o} value={o}>{o || "(leer)"}</option>)}</select>;
  if (field.type === "number") return <input id={id} className="pf-in" type="number" value={typeof value === "number" ? value : ""} onChange={(e) => { if (e.target.value !== "") onChange(Number(e.target.value)); }} />;
  if (field.type === "list") {
    return (
      <>
        <textarea id={id} className="pf-in cfg-json" rows={3} spellCheck={false} value={text} aria-invalid={bad}
          onChange={(e) => {
            setText(e.target.value);
            try { const v: unknown = JSON.parse(e.target.value); if (!Array.isArray(v)) throw new Error(); setBad(false); onInvalid(field.key, false); onChange(v); } catch { setBad(true); onInvalid(field.key, true); }
          }} />
        {bad && <span className="cfg-err" role="alert">Kein gültiges JSON (erwartet wird eine Liste, z. B. [&quot;a&quot;]).</span>}
      </>
    );
  }
  return <input id={id} className="pf-in" type="text" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />;
}

function Fields({ agent, config }: { agent: AgentRef; config: HermesConfig }) {
  const [saved, setSaved] = useState<Draft>(() => Object.fromEntries(config.fields.map((x) => [x.key, x.value])));
  const [draft, setDraft] = useState<Draft>({});
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const categories = useMemo(() => {
    const found = [...new Set(config.fields.map((x) => x.category))];
    return [...config.category_order.filter((c) => found.includes(c)), ...found.filter((c) => !config.category_order.includes(c))];
  }, [config]);
  const [category, setCategory] = useState(categories[0] ?? "general");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);

  const current = (x: ConfigField) => (x.key in draft ? draft[x.key] : saved[x.key]);
  const q = query.trim().toLowerCase();
  const shown = config.fields.filter((x) => (q ? `${x.key} ${x.description}`.toLowerCase().includes(q) : x.category === category));
  const edit = (x: ConfigField, v: unknown) => {
    setDone(false);
    setDraft((d) => { const n = { ...d }; if (same(v, saved[x.key])) delete n[x.key]; else n[x.key] = v; return n; });
  };
  const flag = (key: string, bad: boolean) => setInvalid((s) => { const n = new Set(s); if (bad) n.add(key); else n.delete(key); return n; });
  const count = Object.keys(draft).length;

  const save = async () => {
    setBusy(true); setError(undefined); setDone(false);
    try {
      await api.saveHermesConfig(agent, draft);
      setSaved((s) => ({ ...s, ...draft })); setDraft({}); setDone(true);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="cfg-bar">
        <input type="search" className="pf-in" aria-label="Einstellung suchen" placeholder="Einstellung suchen (alle Bereiche)" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="button" className="btn btn-p" disabled={busy || count === 0 || invalid.size > 0} onClick={() => void save()}>
          <Icon name="check" size={14} />Änderungen speichern{count > 0 ? ` (${count})` : ""}
        </button>
      </div>
      {!q && (
        <div className="tabs" role="tablist" aria-label="Bereiche">
          {categories.map((c) => <button key={c} type="button" role="tab" aria-selected={c === category} className={`tab${c === category ? " on" : ""}`} onClick={() => setCategory(c)}>{c}</button>)}
        </div>
      )}
      {error && <p className="banner" role="alert"><Icon name="alert" /><span>{error}</span></p>}
      {done && <p className="hint" role="status">Gespeichert und vom Dashboard bestätigt.</p>}
      <ul className="cfg-list">
        {shown.map((x) => (
          <li key={x.key} className={`cfg-row${x.key in draft ? " dirty" : ""}`}>
            {x.secret ? (
              <>
                <span className="cfg-name">{x.description}</span>
                <span className="muted">{x.set ? "gesetzt" : "nicht gesetzt"}. Geheimnisse verwaltest du unter <Link to={agentPath(agent, "providers")}>Keys &amp; Nutzung</Link>.</span>
              </>
            ) : (
              <>
                <label className="cfg-name" htmlFor={`cfg-${x.key}`}>{x.description}</label>
                <Editor key={`${x.key}:${q ? "s" : category}`} field={x} value={current(x)} onChange={(v) => edit(x, v)} onInvalid={flag} />
              </>
            )}
            <code className="cfg-key">{x.key}</code>
          </li>
        ))}
        {shown.length === 0 && <li className="muted">Keine Einstellung gefunden.</li>}
      </ul>
    </>
  );
}

/** Alle Einstellungen eines Hermes-Profils, wie das Dashboard sie beschreibt. Geheimnisse bleiben draußen. */
export function ConfigPage({ agent, label }: { agent: AgentRef; label: string }) {
  const status = useAsync(() => api.dashboard(agent), [agent.host, agent.runtime, agent.agent]);
  const info = status.data;
  const config = useAsync(() => (info?.available ? api.hermesConfig(agent) : Promise.resolve(undefined)), [info?.available, agent.host, agent.runtime, agent.agent]);
  return (
    <main className="page">
      <PageHead title="Hermes-Einstellungen" sub={label} />
      <p className="hint">Die Felder kommen vom Dashboard der Installation. Ob eine Änderung sofort, erst für neue Sitzungen oder erst nach einem Neustart des Gateways wirkt, meldet Hermes nicht; im Zweifel das Gateway neu starten.</p>
      {(status.loading || config.loading) && <p className="muted">Lade…</p>}
      {status.error && <p className="banner" role="alert"><Icon name="alert" /><span>Status nicht ladbar: {status.error}</span></p>}
      {info && !info.available && <section className="card soul-off"><h2>Dashboard nicht angebunden</h2><p className="muted">{info.reason}</p><p className="hint">Trage das Dashboard in der Host-Config ein (README, Abschnitt „Dashboard“).</p></section>}
      {config.error && <p className="banner" role="alert"><Icon name="alert" /><span>Einstellungen nicht ladbar: {config.error}</span></p>}
      {config.data && <Fields agent={agent} config={config.data} />}
    </main>
  );
}
