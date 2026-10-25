import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { noteOf, parseSkills, parseToolsets } from "../capabilities";
import { Icon } from "../components/Icon";
import { ToolsetPanel } from "../components/tools/ToolsetPanel";
import { PageHead } from "../components/PageHead";
import type { AgentRef, TerminalBackends, ToolsetInfo, ToolsetRow } from "../types";
import { useAsync } from "../useAsync";
import { t as tr } from "../i18n";

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
      <PageHead title={tr("Skills")} sub={state.data ? `${label} · ${skills.length} installiert` : label} />
      {state.error && <p className="banner" role="alert"><Icon name="alert" />{tr("Skills nicht ladbar: {error}", { error: state.error })}</p>}
      {state.data?.note && <p className="banner" role="status"><Icon name="alert" />{state.data.note}</p>}
      {state.loading && <p className="muted">{tr("Lade…")}</p>}
      {state.data && (
        <>
          <div className="row mem-bar">
            <label className="search grow">
              <Icon name="search" size={14} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr("Skills durchsuchen")} aria-label={tr("Skills durchsuchen")} />
            </label>
          </div>
          {categories.length > 0 && (
            <div className="row mem-chips" role="group" aria-label={tr("Kategorie")}>
              <button type="button" className={`chip chip-s${!category ? " on" : ""}`} aria-pressed={!category} onClick={() => setCategory(undefined)}>{tr("Alle")}</button>
              {categories.map((c) => <button key={c} type="button" className={`chip chip-s${category === c ? " on" : ""}`} aria-pressed={category === c} onClick={() => setCategory(c)}>{c}</button>)}
            </div>
          )}
          {shown.length === 0 ? <p className="panel-empty">{tr("Keine Skills gefunden.")}</p> : (
            <ul className="cap-grid">
              {shown.map((s) => (
                <li key={s.name} className="card cap-card">
                  <b>{s.name}</b>
                  {s.category && <span className="tag tag-m">{s.category}</span>}
                  {s.provenance && <span className="tag">{PROVENANCE[s.provenance] ?? s.provenance}</span>}
                  {s.enabled === false && <span className="tag tag-e">{tr("aus")}</span>}
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
  // Das Dashboard liefert dieselben Gruppen und lässt sie ändern. Ohne Dashboard bleibt die Seite eine reine Anzeige.
  const [managed, setManaged] = useState<ToolsetRow[] | null>(null);
  const [backends, setBackends] = useState<TerminalBackends | null>(null);
  const [open, setOpen] = useState<string>();
  const reload = useCallback(() => api.tools(agent).then((r) => setManaged(r.toolsets), () => setManaged(null)), [agent.host, agent.runtime, agent.agent]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); api.terminalBackends(agent).then(setBackends, () => setBackends(null)); }, [reload]); // eslint-disable-line react-hooks/exhaustive-deps
  const sets: ToolsetInfo[] = managed ?? state.data?.sets ?? [];
  const on = sets.filter((t) => t.enabled).length;
  return (
    <main className="page">
      <PageHead title={tr("Werkzeuge")} sub={state.data || managed ? `${label} · ${on} von ${sets.length} aktiv` : label} />
      {state.error && !managed && <p className="banner" role="alert"><Icon name="alert" />{tr("Werkzeuge nicht ladbar: {error}", { error: state.error })}</p>}
      {state.data?.note && !managed && <p className="banner" role="status"><Icon name="alert" />{state.data.note}</p>}
      {state.loading && !managed && <p className="muted">{tr("Lade…")}</p>}
      {state.data && !managed && sets.length === 0 && <p className="panel-empty">{tr("Der Agent meldet keine Toolsets.")}</p>}
      <ul className="cap-grid">
        {sets.map((t) => (
          <Fragment key={t.name}>
            <li className="card cap-card">
              <div className="row" style={{ gap: 8 }}>
                <b>{t.label ?? t.name}</b>
                {t.enabled !== undefined && <span className={`tag${t.enabled ? " tag-c" : ""}`}>{t.enabled ? tr("aktiv") : "aus"}</span>}
                {t.configured === false && <span className="tag tag-e" title={tr("Es fehlt ein Schlüssel oder eine Einstellung")}>{tr("nicht eingerichtet")}</span>}
              </div>
              {t.description && <p className="muted small">{t.description}</p>}
              {t.tools && t.tools.length > 0 && <div className="row mem-meta">{t.tools.map((n) => <span key={n} className="tag tag-m">{n}</span>)}</div>}
              {managed && (
                <button type="button" className="btn btn-s btn-g" aria-expanded={open === t.name} aria-label={`${t.label ?? t.name} einrichten`} onClick={() => setOpen(open === t.name ? undefined : t.name)}>
                  <Icon name="sliders" size={14} />{tr("Einrichten")}
                </button>
              )}
            </li>
            {managed && open === t.name && (
              <li className="cap-wide"><ToolsetPanel agent={agent} row={managed.find((m) => m.name === t.name) ?? (t as ToolsetRow)} onChanged={() => void reload()} /></li>
            )}
          </Fragment>
        ))}
      </ul>
      {managed && backends && <TerminalNote backends={backends} />}
    </main>
  );
}

/** Das Terminal-Backend bestimmt, wo der Agent Befehle ausführt. Es wird hier nur angezeigt: ein Wechsel hebt die Isolation auf. */
function TerminalNote({ backends }: { backends: TerminalBackends }) {
  const active = backends.backends.find((b) => b.name === backends.active);
  return (
    <section className="card tool-note" aria-label={tr("Terminal-Backend")}>
      <p style={{ margin: 0 }}><b>{tr("Terminal-Backend: {active}", { active: backends.active ?? tr("unbekannt") })}</b>{active?.status && active.status !== "ready" ? ` (${active.status})` : ""}</p>
      <p className="muted small" style={{ margin: "4px 0 0" }}>
        {tr("{description} Umstellen nur im Hermes-Dashboard oder per CLI (", { description: backends.active === "local" ? tr("Befehle laufen direkt auf diesem Rechner, es gibt keine Isolation. ") : (active?.description ?? "") })}<code>hermes tools</code>{tr("), weil es die Isolation des Agenten ändert.")}
      </p>
    </section>
  );
}
