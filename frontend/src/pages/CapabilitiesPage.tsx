import { useMemo, useState } from "react";
import { api } from "../api";
import { noteOf, parseSkills, parseToolsets } from "../capabilities";
import { Icon } from "../components/Icon";
import { PageHead } from "../components/PageHead";
import type { AgentRef } from "../types";
import { useAsync } from "../useAsync";

type Props = { agent: AgentRef; label: string; module: "skills" | "tools" };

/** Was ein Agent kann: installierte Skills und die Werkzeug-Gruppen (Toolsets) mit ihrem Zustand. Nur lesend. */
export function CapabilitiesPage({ agent, label, module }: Props) {
  return module === "skills" ? <Skills agent={agent} label={label} /> : <Toolsets agent={agent} label={label} />;
}

const PROVENANCE: Record<string, string> = { hub: "aus dem Hub", bundled: "mitgeliefert", agent: "selbst erstellt" };

function Skills({ agent, label }: { agent: AgentRef; label: string }) {
  const state = useAsync(async () => { const raw = await api.skills(agent); return { skills: parseSkills(raw), note: noteOf(raw) }; }, [agent.host, agent.runtime, agent.agent]);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<string>();
  const skills = state.data?.skills ?? [];
  const categories = useMemo(() => [...new Set(skills.flatMap((s) => (s.category ? [s.category] : [])))].sort(), [skills]);
  const shown = skills.filter((s) => (!category || s.category === category) && (!q || `${s.name} ${s.description ?? ""}`.toLowerCase().includes(q.toLowerCase())));

  return (
    <main className="page">
      <PageHead title="Skills" sub={state.data ? `${label} · ${skills.length} installiert` : label} />
      {state.error && <p className="banner" role="alert"><Icon name="alert" />Skills nicht ladbar: {state.error}</p>}
      {state.data?.note && <p className="banner" role="status"><Icon name="alert" />{state.data.note}</p>}
      {state.loading && <p className="muted">Lade…</p>}
      {state.data && (
        <>
          <div className="row mem-bar">
            <label className="search grow">
              <Icon name="search" size={14} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Skills durchsuchen" aria-label="Skills durchsuchen" />
            </label>
          </div>
          {categories.length > 0 && (
            <div className="row mem-chips" role="group" aria-label="Kategorie">
              <button type="button" className={`chip chip-s${!category ? " on" : ""}`} aria-pressed={!category} onClick={() => setCategory(undefined)}>Alle</button>
              {categories.map((c) => <button key={c} type="button" className={`chip chip-s${category === c ? " on" : ""}`} aria-pressed={category === c} onClick={() => setCategory(c)}>{c}</button>)}
            </div>
          )}
          {shown.length === 0 ? <p className="panel-empty">Keine Skills gefunden.</p> : (
            <ul className="cap-grid">
              {shown.map((s) => (
                <li key={s.name} className="card cap-card">
                  <b>{s.name}</b>
                  {s.category && <span className="tag tag-m">{s.category}</span>}
                  {s.provenance && <span className="tag">{PROVENANCE[s.provenance] ?? s.provenance}</span>}
                  {s.enabled === false && <span className="tag tag-e">aus</span>}
                  {s.description && <p className="muted small">{s.description}</p>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}

function Toolsets({ agent, label }: { agent: AgentRef; label: string }) {
  const state = useAsync(async () => { const raw = await api.toolsets(agent); return { sets: parseToolsets(raw), note: noteOf(raw) }; }, [agent.host, agent.runtime, agent.agent]);
  const sets = state.data?.sets ?? [];
  const on = sets.filter((t) => t.enabled).length;
  return (
    <main className="page">
      <PageHead title="Werkzeuge" sub={state.data ? `${label} · ${on} von ${sets.length} aktiv` : label} />
      {state.error && <p className="banner" role="alert"><Icon name="alert" />Werkzeuge nicht ladbar: {state.error}</p>}
      {state.data?.note && <p className="banner" role="status"><Icon name="alert" />{state.data.note}</p>}
      {state.loading && <p className="muted">Lade…</p>}
      {state.data && sets.length === 0 && <p className="panel-empty">Der Agent meldet keine Toolsets.</p>}
      <ul className="cap-grid">
        {sets.map((t) => (
          <li key={t.name} className="card cap-card">
            <div className="row" style={{ gap: 8 }}>
              <b>{t.label ?? t.name}</b>
              {t.enabled !== undefined && <span className={`tag${t.enabled ? " tag-c" : ""}`}>{t.enabled ? "aktiv" : "aus"}</span>}
              {t.configured === false && <span className="tag tag-e" title="Es fehlt ein Schlüssel oder eine Einstellung">nicht eingerichtet</span>}
            </div>
            {t.description && <p className="muted small">{t.description}</p>}
            {t.tools && t.tools.length > 0 && <div className="row mem-meta">{t.tools.map((n) => <span key={n} className="tag tag-m">{n}</span>)}</div>}
          </li>
        ))}
      </ul>
    </main>
  );
}
