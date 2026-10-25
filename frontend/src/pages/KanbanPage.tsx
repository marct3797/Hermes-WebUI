import { KanbanAdminPanel } from "../components/KanbanAdminPanel";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHead } from "../components/PageHead";
import { Icon } from "../components/Icon";
import { Sigil } from "../components/Sigil";
import { BoardColumns } from "../components/kanban/Board";
import { Banner, BoardDialog, NewTaskDialog } from "../components/kanban/Dialogs";
import { TaskPanel } from "../components/kanban/TaskPanel";
import { useHosts } from "../hosts";
import { kanbanApi, type BoardData, type BoardMeta } from "../kanbanApi";
import { poll } from "../poll";
import { t as tr } from "../i18n";

const NONE = "\u0000none"; // Filter „ohne Zuweisung“, kann kein Profilname sein
const POLL_MS = 20_000;
type Dialog = "task" | "board-new" | "board-edit" | undefined;

export function KanbanPage({ host }: { host?: string }) {
  const registry = useHosts();
  const [chosen, setChosen] = useState<string>();
  const selected = chosen ?? host ?? registry.hosts?.[0]?.id;
  return (
    <main className="page kb-page">
      <PageHead title={tr("Kanban")} sub={tr("Aufgaben der Agents, Boards gelten für alle Profile")}>
        {registry.hosts && registry.hosts.length > 0 && <label className="row" style={{ gap: 6 }}>{tr("Host")}
          <select className="field field-line" aria-label={tr("Host")} value={selected} onChange={(e) => setChosen(e.target.value)}>{registry.hosts.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}</select></label>}
      </PageHead>
      {registry.error && <Banner error={registry.error} />}
      {!registry.hosts && !registry.error && <p role="status">{tr("Hosts werden geladen…")}</p>}
      {registry.hosts && registry.hosts.length === 0 && <p className="panel-empty">{tr("Keine Hosts konfiguriert. Trage einen Host mit Dashboard in der Host-Konfiguration ein.")}</p>}
      {selected && <HostKanban key={selected} host={selected} />}
    </main>
  );
}

function HostKanban({ host }: { host: string }) {
  const [boards, setBoards] = useState<BoardMeta[]>([]);
  const [board, setBoard] = useState<string>();
  const [data, setData] = useState<BoardData>();
  const [error, setError] = useState<string>();
  const [moveError, setMoveError] = useState<unknown>();
  const [archived, setArchived] = useState(false);
  const [query, setQuery] = useState("");
  const [who, setWho] = useState<string>();
  const [dragId, setDragId] = useState<string>();
  const [open, setOpen] = useState<string>();
  const [rev, setRev] = useState(0);
  const [dialog, setDialog] = useState<Dialog>();
  const [loading, setLoading] = useState(true);
  const boardRef = useRef<string>();
  const archRef = useRef(false);
  const seq = useRef(0);
  const alive = useRef(true);

  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const bs = await kanbanApi.boards(host);
      const slug = bs.boards.some((b) => b.slug === boardRef.current) ? boardRef.current : bs.current ?? bs.boards[0]?.slug;
      const next = await kanbanApi.board(host, slug, archRef.current);
      if (!alive.current || n !== seq.current) return;
      boardRef.current = slug; setBoard(slug); setBoards(bs.boards); setData(next); setError(undefined);
    } catch (e) {
      if (alive.current && n === seq.current) setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally { if (alive.current && n === seq.current) setLoading(false); }
  }, [host]);

  useEffect(() => {
    alive.current = true;
    load().catch(() => undefined);
    const stop = poll(load, POLL_MS);
    return () => { alive.current = false; stop(); };
  }, [load]);

  const switchBoard = (slug: string) => { boardRef.current = slug; setBoard(slug); setData(undefined); setOpen(undefined); setLoading(true); load().catch(() => undefined); };
  const toggleArchived = (on: boolean) => { archRef.current = on; setArchived(on); load().catch(() => undefined); };

  const all = useMemo(() => data?.columns.flatMap((c) => c.tasks) ?? [], [data]);
  const q = query.trim().toLowerCase();
  const filtered = !!q || who !== undefined;
  const columns = useMemo(() => (data?.columns ?? []).map((c) => ({
    ...c,
    tasks: c.tasks.filter((t) => (who === undefined || (who === NONE ? !t.assignee : t.assignee === who)) && (!q || `${t.title} ${t.snippet} ${t.id}`.toLowerCase().includes(q))),
  })), [data, q, who]);
  const totals = useMemo(() => Object.fromEntries((data?.columns ?? []).map((c) => [c.name, c.tasks.length])), [data]);
  const unassigned = all.filter((t) => !t.assignee).length;
  const current = boards.find((b) => b.slug === board);
  const statuses = (data?.columns ?? []).map((c) => c.name).filter((n) => n !== "archived");
  const names = (data?.assignees ?? []).map((a) => a.name);

  const move = async (id: string, to: string) => {
    const prev = data;
    const card = all.find((t) => t.id === id);
    if (!prev || !card || card.status === to) return;
    setMoveError(undefined);
    // Sofort zeigen, bei Fehler zurück auf den Stand davor.
    setData({ ...prev, columns: prev.columns.map((c) => c.name === card.status ? { ...c, tasks: c.tasks.filter((t) => t.id !== id) } : c.name === to ? { ...c, tasks: [{ ...card, status: to }, ...c.tasks] } : c) });
    try {
      await kanbanApi.patchTask(host, board, id, { status: to });
      if (id === open) setRev((r) => r + 1);
      await load().catch(() => undefined);
    } catch (e) { setData(prev); setMoveError(e); }
  };

  const counts = current?.counts ?? {};
  const stat = (k: string) => data?.stats.by_status[k] ?? counts[k] ?? 0;
  const empty = !!data && all.length === 0 && !archived;
  return (
    <>
      <div className="kb-bar row" style={{ gap: 8, flexWrap: "wrap" }}>
        <label className="row" style={{ gap: 6 }}>{tr("Board")}
          <select className="field field-line" aria-label={tr("Board")} value={board ?? ""} disabled={boards.length === 0} onChange={(e) => switchBoard(e.target.value)}>
            {boards.map((b) => <option key={b.slug} value={b.slug}>{b.name} ({b.total})</option>)}</select></label>
        {current && <button type="button" className="btn btn-s btn-g" onClick={() => setDialog("board-edit")}><Icon name="edit" size={14} />{tr("Board bearbeiten")}</button>}
        <button type="button" className="btn btn-s" onClick={() => setDialog("board-new")}><Icon name="plus" size={14} />{tr("Neues Board")}</button>
        <button type="button" className="btn btn-s btn-p" disabled={!data} onClick={() => setDialog("task")}><Icon name="plus" size={14} />{tr("Neue Aufgabe")}</button>
        <input className="field field-line grow" type="search" aria-label={tr("Aufgaben suchen")} placeholder={tr("Suche in Titel, Text und Kennung")} value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={archived} onChange={(e) => toggleArchived(e.target.checked)} />{tr("Archivierte zeigen")}</label>
        <button type="button" className="btn btn-s btn-g" onClick={() => { setLoading(true); load().catch(() => undefined); }} disabled={loading}><Icon name="refresh" size={14} />{tr("Neu laden")}</button>
      </div>
      {data && <p className="mono small t3 kb-stat" aria-label={tr("Kurzstatistik")}>{tr("{v} Aufgaben · {stat} blockiert · {stat2} laufend · {stat3} erledigt{oldest_ready_age_seconds}", { v: all.length, stat: stat("blocked"), stat2: stat("running"), stat3: stat("done"), oldest_ready_age_seconds: data.stats.oldest_ready_age_seconds ? tr(" · älteste bereite Aufgabe {v} Min", { v: Math.round(data.stats.oldest_ready_age_seconds / 60) }) : "" })}</p>}
      {data && <div className="chips row kb-chips" role="group" aria-label={tr("Zugewiesen an")} style={{ gap: 6, flexWrap: "wrap" }}>
        <span className="small t3">{tr("Zugewiesen an")}</span>
        <button type="button" className={`chip${who === undefined ? " on" : ""}`} aria-pressed={who === undefined} onClick={() => setWho(undefined)}>{tr("Alle ({v})", { v: all.length })}</button>
        {data.assignees.map((a) => {
          const n = Object.entries(a.counts).reduce((s, [k, v]) => s + (k === "archived" && !archived ? 0 : v), 0);
          return <button key={a.name} type="button" className={`chip${who === a.name ? " on" : ""}`} aria-pressed={who === a.name} onClick={() => setWho(who === a.name ? undefined : a.name)}><Sigil name={a.name} size="xs" />{a.name} ({n})</button>;
        })}
        {unassigned > 0 && <button type="button" className={`chip${who === NONE ? " on" : ""}`} aria-pressed={who === NONE} onClick={() => setWho(who === NONE ? undefined : NONE)}>{tr("Ohne Zuweisung ({unassigned})", { unassigned })}</button>}
      </div>}
      {error && <Banner error={tr("Kanban nicht ladbar: {error}", { error })} />}
      <Banner error={moveError} />
      {loading && !data && !error && <p role="status">{tr("Board wird geladen…")}</p>}
      {empty && <div className="panel-empty" role="status"><p>{tr("Keine Aufgaben, lege die erste an.")}</p><button type="button" className="btn btn-s btn-p" onClick={() => setDialog("task")}>{tr("Neue Aufgabe")}</button></div>}
      <div className={`kb-layout${open ? " has-panel" : ""}`}>
        {data && <BoardColumns columns={columns} total={totals} filtered={filtered} selected={open} dragId={dragId} onOpen={setOpen} onMove={(id, to) => void move(id, to)} onDragId={setDragId} />}
        {open && <TaskPanel key={`${open}:${rev}`} host={host} board={board} id={open} columns={statuses} assignees={names} allTasks={all} onClose={() => setOpen(undefined)} onChanged={() => void load().catch(() => undefined)} />}
      </div>
      {dialog === "task" && <NewTaskDialog assignees={names} tasks={all} onClose={() => setDialog(undefined)} onCreate={async (t) => {
        const r = await kanbanApi.createTask(host, board, t);
        setDialog(undefined); await load().catch(() => undefined); if (r.id) setOpen(r.id);
      }} />}
      <KanbanAdminPanel host={host} board={board} onChanged={() => void load().catch(() => undefined)} onImported={(slug) => switchBoard(slug)} />
      {dialog === "board-new" && <BoardDialog onClose={() => setDialog(undefined)} onSave={async (b) => {
        await kanbanApi.createBoard(host, { slug: b.slug, name: b.name, ...(b.description ? { description: b.description } : {}), ...(b.color ? { color: b.color } : {}) });
        setDialog(undefined); switchBoard(b.slug);
      }} />}
      {dialog === "board-edit" && current && <BoardDialog board={current} onClose={() => setDialog(undefined)} onSave={async (b) => {
        await kanbanApi.updateBoard(host, current.slug, { name: b.name, description: b.description, ...(b.color ? { color: b.color } : {}) });
        setDialog(undefined); await load().catch(() => undefined);
      }} />}
    </>
  );
}
