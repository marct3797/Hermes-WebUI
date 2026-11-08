import { call } from "./api";

const enc = encodeURIComponent;

export type Job = {
  id: string; name: string; prompt: string; skills: string[]; model: string | null; provider: string | null;
  system: boolean; script: string | null; no_agent: boolean;
  schedule: { kind: string | null; expr: string | null; minutes: number | null; display: string | null };
  repeat: { times: number | null; completed: number };
  enabled: boolean; state: string; paused_reason: string | null;
  next_run_at: string | null; last_run_at: string | null; last_status: string | null; last_error: string | null; failure_streak: number;
  deliver: string; latest: { status: string | null; started_at: string | null; finished_at: string | null } | null;
};
export type Run = { id: string; status: string | null; started_at: number | null; ended_at: number | null; duration_s: number | null; preview: string; active: boolean };
export type Target = { id: string; name: string; ready: boolean };
export type BlueprintField = { name: string; type: string; label: string; default: string; options: string[]; optional: boolean; help: string | null };
export type Blueprint = { key: string; title: string; description: string; category: string | null; schedule_human: string | null; fields: BlueprintField[] };
export type JobInput = { name?: string; schedule?: string; prompt?: string; deliver?: string; repeat?: number; skills?: string[]; repeat_unlimited?: boolean; confirm_system?: boolean; script?: string; no_agent?: boolean };

const cron = (host: string, profile: string) => `/bff/h/${enc(host)}/_cron/${enc(profile)}`;
const job = (host: string, profile: string, id: string) => `${cron(host, profile)}/schedules/${enc(id)}`;

export const cronApi = {
  list: (h: string, p: string) => call<{ jobs: Job[] }>("GET", `${cron(h, p)}/schedules`),
  runs: (h: string, p: string, id: string) => call<{ runs: Run[] }>("GET", `${job(h, p, id)}/runs?limit=20`),
  targets: (h: string, p: string) => call<{ targets: Target[] }>("GET", `${cron(h, p)}/targets`),
  skills: (h: string, p: string) => call<{ skills: string[] }>("GET", `${cron(h, p)}/skill-names`),
  blueprints: (h: string, p: string) => call<{ blueprints: Blueprint[] }>("GET", `${cron(h, p)}/blueprints`),
  create: (h: string, p: string, body: JobInput) => call<Job>("POST", `${cron(h, p)}/schedules`, body),
  update: (h: string, p: string, id: string, body: JobInput) => call<Job>("PUT", job(h, p, id), body),
  act: (h: string, p: string, id: string, action: "pause" | "resume" | "trigger", confirmSystem = false) =>
    call<Job>("POST", `${job(h, p, id)}/${action}`, confirmSystem ? { confirm_system: true } : undefined),
  remove: (h: string, p: string, id: string, confirmSystem = false) => call<{ ok: boolean }>("DELETE", job(h, p, id), confirmSystem ? { confirm_system: true } : undefined),
  instantiate: (h: string, p: string, blueprint: string, values: Record<string, string>) => call<Job>("POST", `${cron(h, p)}/blueprints`, { blueprint, values }),
};

export const LOG_FILES = ["agent", "errors", "gateway", "gui", "desktop"] as const;
export const LOG_LEVELS = ["ALL", "DEBUG", "INFO", "WARNING", "ERROR"] as const;
export const LOG_COMPONENTS = ["all", "gateway", "agent", "tools", "cli", "cron", "gui"] as const;
export type LogQuery = { profile?: string; file: string; lines: number; level: string; component: string; search: string };
export type LogResult = { file: string; lines: string[]; redacted: boolean; truncated: boolean };
export const logsApi = {
  get: (host: string, q: LogQuery, signal?: AbortSignal) => {
    const p = new URLSearchParams({ file: q.file, lines: String(q.lines), level: q.level, component: q.component });
    if (q.search) p.set("search", q.search);
    if (q.profile) p.set("profile", q.profile);
    return call<LogResult>("GET", `/bff/h/${enc(host)}/_logs?${p}`, undefined, signal);
  },
};

export type KnowledgeDocument = {
  sync_id: string; source: string; repo: string | null; path: string | null; commit: string | null; title: string | null;
  chunks: number; truncated: boolean; editable: boolean; text: string; parts: { index: number; text: string }[];
};
const kn = (p: string) => `/bff/knowledge/${enc(p)}`;
export const knowledgeDocApi = {
  get: (p: string, syncId: string) => call<KnowledgeDocument>("GET", `${kn(p)}/documents/${syncId.split("/").map(enc).join("/")}`),
  replace: (p: string, syncId: string, body: { title?: string; text: string }) =>
    call<{ ok: boolean; sync_id: string; chunks: number; removed: number }>("PUT", `${kn(p)}/documents/${syncId.split("/").map(enc).join("/")}`, body),
};
export const INGEST_MAX = 1_048_576;
/** Grobe Schätzung (etwa 4 Zeichen je Token); der Dienst teilt nach Token. */
export const estimateChunks = (chars: number, size = 512, overlap = 50) => (chars <= 0 ? 0 : Math.max(1, Math.ceil((chars - overlap * 4) / (Math.max(1, size - overlap) * 4))));
