import { useCallback, useEffect, useMemo, useState } from "react";
import { p3, type LGraph, type LNodeDetail } from "../p3Api";
import { PageHead } from "../components/PageHead";
import { useAction } from "../components/useAction";
import type { AgentRef } from "../types";

/** Was Hermes gelernt hat: Skills und Erinnerungen als Liste mit Verbindungen. Bearbeiten und Löschen nur mit frischer Anmeldung. */
export default function LearningPage({ agent }: { agent: AgentRef }) {
  const [g, setG] = useState<LGraph | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [open, setOpen] = useState<LNodeDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [typed, setTyped] = useState("");
  const [filter, setFilter] = useState("");
  const { run, notes, busy } = useAction();
  const load = useCallback(async () => setG(await p3.graph(agent)), [agent]);
  useEffect(() => { load().catch((e) => setLoadErr((e as Error).message)); }, [load]);
  const links = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of g?.edges ?? []) { m.set(e.source, (m.get(e.source) ?? 0) + 1); m.set(e.target, (m.get(e.target) ?? 0) + 1); }
    return m;
  }, [g]);
  const nodes = (g?.nodes ?? []).filter((n) => !filter || `${n.id} ${n.label}`.toLowerCase().includes(filter.toLowerCase()));
  const show = (id: string) => void run(async () => { const d = await p3.node(agent, id); setOpen(d); setDraft(d.content); setTyped(""); });

  return (
    <article>
      <PageHead title="Lerngraph" sub={g ? `${g.nodes.length} Knoten, ${g.edges.length} Verbindungen${g.nodes.length >= 500 ? " (auf 500 begrenzt)" : ""}` : "lädt …"} />
      {notes}
      {loadErr && <p className="banner" role="alert">{loadErr}</p>}
      {g && g.nodes.length === 0 && <p>Noch nichts gelernt: keine Skills oder Erinnerungen vorhanden.</p>}
      <input aria-label="Knoten suchen" placeholder="Suche" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <ul aria-label="Knoten">{nodes.map((n) => (
        <li key={n.id}><button type="button" onClick={() => show(n.id)}>{n.label || n.id}</button> ({n.kind}{n.category ? `, ${n.category}` : ""}), {links.get(n.id) ?? 0} Verbindungen, {n.use_count}x genutzt{n.pinned ? ", angeheftet" : ""}</li>))}</ul>
      {open && <section aria-label="Knoten bearbeiten">
        <h2>{open.label || open.id}</h2>
        <textarea aria-label="Knoteninhalt" rows={14} maxLength={100000} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button type="button" disabled={busy || !draft.trim() || draft === open.content} onClick={() => void run(async () => { await p3.nodeSave(agent, open.id, draft); const d = await p3.node(agent, open.id); setOpen(d); setDraft(d.content); await load(); })}>Speichern</button>
        <label>Zum Löschen die ID eintippen <input aria-label="Knoten-ID zum Löschen" placeholder={open.id} value={typed} onChange={(e) => setTyped(e.target.value)} /></label>
        <button type="button" disabled={busy || typed !== open.id} onClick={() => void run(async () => { await p3.nodeDelete(agent, open.id); setOpen(null); await load(); })}>Knoten löschen</button>
      </section>}
    </article>
  );
}
