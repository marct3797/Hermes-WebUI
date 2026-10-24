import { useState } from "react";
import { Icon } from "../Icon";
import { Sigil } from "../Sigil";
import { fmtAgo } from "../../format";
import type { Card, Column } from "../../kanbanApi";

const LABEL: Record<string, string> = { triage: "Einordnung", todo: "Offen", scheduled: "Geplant", ready: "Bereit", running: "Läuft", blocked: "Blockiert", review: "Prüfung", done: "Erledigt", archived: "Archiviert" };
export const columnLabel = (name: string) => LABEL[name] ?? name;
/** Laufend setzt nur der Dispatcher; dorthin lässt sich nichts ziehen. */
export const droppable = (name: string) => name !== "running" && name !== "archived";
const PAGE = 30;

export function TaskCard({ card, columns, selected, dragging, onOpen, onMove, onDragStart, onDragEnd }: {
  card: Card; columns: string[]; selected: boolean; dragging: boolean; onOpen: () => void; onMove: (to: string) => void; onDragStart: () => void; onDragEnd: () => void;
}) {
  const warn = card.warnings.count > 0;
  return (
    <li className={`kb-card${selected ? " sel" : ""}${dragging ? " drag" : ""}`} draggable={card.status !== "archived"} data-task={card.id}
      onDragStart={(e) => { e.dataTransfer?.setData("text/plain", card.id); if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"; onDragStart(); }} onDragEnd={onDragEnd}>
      <button type="button" className="kb-open" onClick={onOpen} aria-label={`Aufgabe öffnen: ${card.title}`}>
        <span className="kb-title">{card.title}</span>
        {card.snippet && <span className="kb-snip">{card.snippet}</span>}
      </button>
      <div className="kb-meta">
        {card.assignee ? <span className="kb-who"><Sigil name={card.assignee} size="xs" />{card.assignee}</span> : <span className="t3">Niemand</span>}
        {card.priority !== 0 && <span className="chip chip-s" title="Priorität">P{card.priority}</span>}
        {card.age_seconds !== null && <span className="t3 small" title="Alter">{fmtAgo(Date.now() - card.age_seconds * 1000)}</span>}
        {card.comment_count > 0 && <span className="t3 small" title="Kommentare"><Icon name="chat" size={12} /> {card.comment_count}</span>}
        {warn && <span className="kb-warn" role="img" aria-label={`${card.warnings.count} Warnung${card.warnings.count === 1 ? "" : "en"}`} title="Diagnose an dieser Aufgabe"><Icon name="alert" size={12} /></span>}
        <select className="kb-move" aria-label={`${card.title} verschieben nach`} value="" onChange={(e) => e.target.value && onMove(e.target.value)}>
          <option value="">Verschieben nach…</option>
          {columns.filter((c) => c !== card.status && droppable(c)).map((c) => <option key={c} value={c}>{columnLabel(c)}</option>)}
        </select>
      </div>
    </li>
  );
}

export function BoardColumns({ columns, total, filtered, selected, dragId, onOpen, onMove, onDragId }: {
  columns: Column[]; total: Record<string, number>; filtered: boolean; selected?: string; dragId?: string;
  onOpen: (id: string) => void; onMove: (id: string, to: string) => void; onDragId: (id?: string) => void;
}) {
  const [limit, setLimit] = useState<Record<string, number>>({});
  const [over, setOver] = useState<string>();
  const names = columns.map((c) => c.name);
  return (
    <div className="kb-board">
      {columns.map((col) => {
        const shown = col.tasks.slice(0, limit[col.name] ?? PAGE);
        const ok = droppable(col.name);
        return (
          <section key={col.name} className={`kb-col${over === col.name ? " over" : ""}${dragId && !ok ? " nodrop" : ""}${!dragId && col.tasks.length === 0 ? " empty" : ""}`} aria-label={`Spalte ${columnLabel(col.name)}`}
            onDragOver={(e) => { if (dragId && ok) { e.preventDefault(); setOver(col.name); } }} onDragLeave={() => setOver((o) => (o === col.name ? undefined : o))}
            onDrop={(e) => { e.preventDefault(); setOver(undefined); const id = dragId ?? e.dataTransfer?.getData("text/plain"); onDragId(undefined); if (id && ok) onMove(id, col.name); }}>
            <h2 className="kb-colh" title={columnLabel(col.name)}><span>{columnLabel(col.name)}</span><span className="mono small t3" data-testid="count">{filtered ? `${col.tasks.length} von ${total[col.name] ?? col.tasks.length}` : col.tasks.length}</span></h2>
            <ul className="kb-cards">
              {shown.map((c) => <TaskCard key={c.id} card={c} columns={names} selected={selected === c.id} dragging={dragId === c.id} onOpen={() => onOpen(c.id)}
                onMove={(to) => onMove(c.id, to)} onDragStart={() => onDragId(c.id)} onDragEnd={() => { onDragId(undefined); setOver(undefined); }} />)}
              {col.tasks.length === 0 && <li className="kb-none t3 small">{filtered ? "Nichts passt zum Filter" : "Leer"}</li>}
            </ul>
            {col.tasks.length > shown.length && <button type="button" className="btn btn-s btn-g" onClick={() => setLimit({ ...limit, [col.name]: shown.length + PAGE })}>Mehr laden ({col.tasks.length - shown.length} weitere)</button>}
          </section>
        );
      })}
    </div>
  );
}
