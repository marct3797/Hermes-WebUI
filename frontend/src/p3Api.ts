import { call } from "./api";
import type { AgentRef } from "./types";

const base = (a: AgentRef) => `/bff/h/${encodeURIComponent(a.host)}/${encodeURIComponent(a.runtime)}/${encodeURIComponent(a.agent)}`;
const q = encodeURIComponent;

// Schlüssel-Pools (der Schlüssel selbst kommt nie zurück, nur die letzten vier Zeichen)
export type PoolEntry = { index: number; label: string; auth_type: string; source: string; last_status: string | null; request_count: number; token_tail: string; has_refresh: boolean };
export type Pool = { providers: Array<{ provider: string; entries: PoolEntry[] }> };
// Sprache
export type VoiceStatus = { mode: string; available: boolean; reason: string };
// System, Curator, Lerngraph
export type SystemStats = { hermes_version?: string; hostname?: string; system?: string; arch?: string; python_version?: string; cpu_count?: number; cpu_percent?: number; uptime_seconds?: number; memory?: Record<string, number>; disk?: Record<string, number> };
export type Curator = { enabled: boolean; paused: boolean; interval_hours: number | null; last_run_at: number | null; min_idle_hours: number | null; stale_after_days: number | null; archive_after_days: number | null };
export type CuratorLog = { running: boolean; exit_code: number | null; log: string };
export type LNode = { id: string; label: string; kind: string; category: string; use_count: number; state: string; pinned: boolean };
export type LGraph = { nodes: LNode[]; edges: Array<{ source: string; target: string }> };
export type LNodeDetail = { id: string; kind: string; label: string; content: string };
// Darstellung und Datenschutz
export type Appearance = { themes: Array<{ name: string; label: string; description: string }>; active: string; font: string; fonts: string[] };
export type Metrics = { enabled: boolean; send: boolean; decided: boolean; managed: boolean };
export type Privacy = { egress: string; metrics: Metrics };

export const p3 = {
  poolList: (a: AgentRef) => call<Pool>("GET", `${base(a)}/hermes-credentials`),
  poolAdd: (a: AgentRef, b: { provider: string; api_key: string; label?: string }) => call<{ ok: boolean; count: number }>("POST", `${base(a)}/hermes-credentials`, b),
  poolRemove: (a: AgentRef, provider: string, index: number) => call<{ ok: boolean; count: number }>("DELETE", `${base(a)}/hermes-credentials/${q(provider)}/${index}?confirm=${q(provider)}`),
  voiceStatus: (a: AgentRef) => call<VoiceStatus>("GET", `${base(a)}/hermes-voice/status`),
  speak: (a: AgentRef, text: string) => call<{ data_url: string; mime_type: string; provider: string }>("POST", `${base(a)}/hermes-voice/speak`, { text }),
  transcribe: (a: AgentRef, data_url: string, mime_type?: string) => call<{ transcript: string; provider: string }>("POST", `${base(a)}/hermes-voice/transcribe`, { data_url, ...(mime_type ? { mime_type } : {}) }),
  system: (a: AgentRef) => call<SystemStats>("GET", `${base(a)}/hermes-system`),
  curator: (a: AgentRef) => call<Curator>("GET", `${base(a)}/hermes-curator`),
  curatorPause: (a: AgentRef, paused: boolean) => call<{ ok: boolean }>("PUT", `${base(a)}/hermes-curator/paused`, { paused }),
  curatorRun: (a: AgentRef) => call<{ started: boolean }>("POST", `${base(a)}/hermes-curator/run`, { confirm_archive: true }),
  curatorLog: (a: AgentRef) => call<CuratorLog>("GET", `${base(a)}/hermes-curator/run`),
  graph: (a: AgentRef) => call<LGraph>("GET", `${base(a)}/hermes-learning`),
  node: (a: AgentRef, id: string) => call<LNodeDetail>("GET", `${base(a)}/hermes-learning/node?id=${q(id)}`),
  nodeSave: (a: AgentRef, id: string, content: string) => call<{ ok: boolean }>("PUT", `${base(a)}/hermes-learning/node`, { id, content }),
  nodeDelete: (a: AgentRef, id: string) => call<{ ok: boolean }>("DELETE", `${base(a)}/hermes-learning/node?id=${q(id)}&confirm=${q(id)}`),
  appearance: (a: AgentRef) => call<Appearance>("GET", `${base(a)}/hermes-appearance`),
  theme: (a: AgentRef, name: string) => call<{ ok: boolean }>("PUT", `${base(a)}/hermes-appearance/theme`, { name }),
  font: (a: AgentRef, font: string) => call<{ ok: boolean }>("PUT", `${base(a)}/hermes-appearance/font`, { font }),
  privacy: (a: AgentRef) => call<Privacy>("GET", `${base(a)}/hermes-privacy`),
  metrics: (a: AgentRef, b: { enabled: boolean; send: boolean; confirm_send?: boolean }) => call<{ ok: boolean; metrics: Metrics }>("PUT", `${base(a)}/hermes-privacy/metrics`, b),
};

// Host-Ebene: Kanban in der Tiefe und Achievements
const hb = (host: string) => `/bff/h/${encodeURIComponent(host)}`;
const bq = (board?: string) => (board ? `?board=${q(board)}` : "");
export type KbDiag = { count: number; items: Array<{ task_id: string; title: string; status: string; assignee: string; diagnostics: Array<{ kind: string; severity: string; title: string; detail: string }> }> };
export type KbWorker = { run_id: number | null; task_id: string; title: string; profile: string; started_at: number | null; last_heartbeat_at: number | null; max_runtime_seconds: number | null };
export type KbDispatch = { dry_run: boolean; spawned: string[]; promoted: string[] };
export type Achievements = { total: number; unlocked: number; discovered: number; secret: number; generated_at: number | null; is_stale: boolean;
  items: Array<{ id: string; name: string; description: string; category: string; icon: string; state: string; unlocked: boolean; tier: string | null; progress: number; next_threshold: number | null; progress_pct: number; unlocked_at: number | null }> };
export const hostApi = {
  kbDiag: (host: string, board?: string) => call<KbDiag>("GET", `${hb(host)}/_kanban/diagnostics${bq(board)}`),
  kbWorkers: (host: string, board?: string) => call<{ count: number; workers: KbWorker[] }>("GET", `${hb(host)}/_kanban/workers${bq(board)}`),
  kbTerminate: (host: string, run: number, board?: string) => call<{ ok: boolean }>("POST", `${hb(host)}/_kanban/runs/${run}/terminate${bq(board)}`, { confirm: String(run) }),
  kbEstimate: (host: string, task: string, board?: string) => call<{ ok: boolean; est_tokens: number | null; complexity: string; rationale: string; reason: string }>("POST", `${hb(host)}/_kanban/tasks/${q(task)}/estimate${bq(board)}`),
  kbSpecify: (host: string, task: string, board?: string) => call<{ ok: boolean; reason: string; new_title: string }>("POST", `${hb(host)}/_kanban/tasks/${q(task)}/specify${bq(board)}`, { confirm: true }),
  kbDispatch: (host: string, dry_run: boolean, board?: string) => call<KbDispatch>("POST", `${hb(host)}/_kanban/dispatch${bq(board)}`, dry_run ? { dry_run: true } : { dry_run: false, confirm_spawn: true }),
  achievements: (host: string) => call<Achievements>("GET", `${hb(host)}/_achievements`),
  achRescan: (host: string) => call<Achievements>("POST", `${hb(host)}/_achievements/rescan`),
  achReset: (host: string) => call<{ ok: boolean }>("POST", `${hb(host)}/_achievements/reset`, { confirm: "reset" }),
};
