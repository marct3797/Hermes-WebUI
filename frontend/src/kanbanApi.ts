import { call } from "./api";
import { t as tr } from "./i18n";

export type Card = {
  id: string; title: string; status: string; assignee: string | null; priority: number; created_at: number | null; completed_at: number | null;
  age_seconds: number | null; comment_count: number; link_counts: { parents: number; children: number };
  warnings: { count: number; highest_severity: string | null }; block_kind: string | null; snippet: string;
};
export type Column = { name: string; tasks: Card[] };
export type AssigneeInfo = { name: string; counts: Record<string, number> };
export type BoardData = { columns: Column[]; assignees: AssigneeInfo[]; stats: { by_status: Record<string, number>; oldest_ready_age_seconds: number | null } };
export type BoardMeta = { slug: string; name: string; description: string; icon: string; color: string; archived: boolean; is_current: boolean; counts: Record<string, number>; total: number };
export type TaskDetail = {
  task: Pick<Card, "id" | "title" | "status" | "assignee" | "priority" | "created_at" | "completed_at" | "block_kind"> & {
    body: string; created_by: string | null; started_at: number | null; result: string | null; summary: string | null; consecutive_failures: number; last_failure_error: string | null;
  };
  comments: { id: number | null; author: string | null; body: string; created_at: number | null }[];
  events: { id: number | null; kind: string | null; created_at: number | null; run_id: number | null }[];
  runs: { id: number | null; profile: string | null; status: string | null; outcome: string | null; started_at: number | null; ended_at: number | null; summary: string | null; error: string | null }[];
  links: { parents: string[]; children: string[] };
  link_tasks: { id: string; title: string; status: string }[];
  diagnostics: { kind: string; severity: string | null; title: string; detail: string }[];
};
export type TaskLog = { exists: boolean; size_bytes: number; truncated: boolean; content: string };
export type NewTask = { title: string; body?: string; assignee?: string; priority?: number; status?: "todo" | "ready" | "triage"; parents?: string[] };
export type TaskPatch = Partial<{ status: string; assignee: string; priority: number; title: string; body: string; block_reason: string; result: string; summary: string }>;
export type BulkResult = { results: { id: string; ok: boolean; error: string | null }[] };

const base = (host: string) => `/bff/h/${encodeURIComponent(host)}/_kanban`;
const bq = (board?: string, extra = "") => {
  const p = [board ? `board=${encodeURIComponent(board)}` : "", extra].filter(Boolean).join("&");
  return p ? `?${p}` : "";
};

export const kanbanApi = {
  boards: (host: string) => call<{ boards: BoardMeta[]; current: string | null }>("GET", `${base(host)}/boards`),
  board: (host: string, board: string | undefined, archived: boolean) => call<BoardData>("GET", `${base(host)}/board${bq(board, archived ? "include_archived=true" : "")}`),
  createBoard: (host: string, b: { slug: string; name: string; description?: string; color?: string }) => call<{ board: BoardMeta }>("POST", `${base(host)}/boards`, b),
  updateBoard: (host: string, slug: string, b: { name?: string; description?: string; color?: string }) => call<{ board: BoardMeta }>("PATCH", `${base(host)}/boards/${encodeURIComponent(slug)}`, b),
  task: (host: string, board: string | undefined, id: string) => call<TaskDetail>("GET", `${base(host)}/tasks/${encodeURIComponent(id)}${bq(board)}`),
  log: (host: string, board: string | undefined, id: string, tail: number) => call<TaskLog>("GET", `${base(host)}/tasks/${encodeURIComponent(id)}/log${bq(board, `tail=${tail}`)}`),
  createTask: (host: string, board: string | undefined, t: NewTask) => call<{ id: string | null; warning: string | null }>("POST", `${base(host)}/tasks${bq(board)}`, t),
  patchTask: (host: string, board: string | undefined, id: string, p: TaskPatch) => call<{ ok: true }>("PATCH", `${base(host)}/tasks/${encodeURIComponent(id)}${bq(board)}`, p),
  comment: (host: string, board: string | undefined, id: string, body: string) => call<{ ok: true }>("POST", `${base(host)}/tasks/${encodeURIComponent(id)}/comments${bq(board)}`, { body }),
  reassign: (host: string, board: string | undefined, id: string, assignee: string, reclaim_first: boolean) =>
    call<{ ok: true }>("POST", `${base(host)}/tasks/${encodeURIComponent(id)}/reassign${bq(board)}`, { assignee, reclaim_first }),
  reclaim: (host: string, board: string | undefined, id: string) => call<{ ok: true }>("POST", `${base(host)}/tasks/${encodeURIComponent(id)}/reclaim${bq(board)}`, {}),
  link: (host: string, board: string | undefined, parent_id: string, child_id: string) => call<{ ok: true; gated: boolean }>("POST", `${base(host)}/links${bq(board)}`, { parent_id, child_id }),
  unlink: (host: string, board: string | undefined, parent_id: string, child_id: string) =>
    call<{ ok: boolean }>("DELETE", `${base(host)}/links${bq(board, `parent_id=${encodeURIComponent(parent_id)}&child_id=${encodeURIComponent(child_id)}`)}`),
  bulk: (host: string, board: string | undefined, b: { ids: string[]; status?: string; assignee?: string; priority?: number; archive?: boolean }) =>
    call<BulkResult>("POST", `${base(host)}/tasks/bulk${bq(board)}`, b),
};

/** Ein Bulk-Aufruf mit einer ID meldet Einzelfehler im Ergebnis; für die Oberfläche wird daraus ein Fehler. */
export function assertBulk(r: BulkResult): void {
  const bad = r.results.find((x) => !x.ok);
  if (bad) throw new Error(bad.error ?? tr("Das Dashboard hat die Änderung abgelehnt"));
}
