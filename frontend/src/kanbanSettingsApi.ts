import { call } from "./api";

export type KbProfile = { name: string; is_default: boolean; model: string; provider: string; description: string; description_auto: boolean; skill_count: number | null };
export type KbOrch = { orchestrator_profile: string; default_assignee: string; auto_decompose: boolean; auto_promote_children: boolean; resolved_orchestrator_profile: string; resolved_default_assignee: string; active_profile: string };
export type KbSettings = {
  config: { default_tenant: string; lane_by_profile: boolean; include_archived_by_default: boolean; render_markdown: boolean } | null;
  orchestration: KbOrch | null;
  columns: { key: string; label: string }[] | null;
  profiles: KbProfile[] | null;
  notes: Record<string, string>;
};
export type KbHome = { platform: string; name: string; subscribed: boolean };

const base = (host: string) => `/bff/h/${encodeURIComponent(host)}/_kanban`;
const q = (board?: string, task?: string) => { const p = [board && `board=${encodeURIComponent(board)}`, task && `task_id=${encodeURIComponent(task)}`].filter(Boolean).join("&"); return p ? `?${p}` : ""; };

export const kbSettingsApi = {
  settings: (host: string) => call<KbSettings>("GET", `${base(host)}/settings`),
  setOrch: (host: string, body: Partial<Pick<KbOrch, "orchestrator_profile" | "default_assignee" | "auto_decompose" | "auto_promote_children">>) => call<KbOrch>("PUT", `${base(host)}/orchestration`, body),
  setDescription: (host: string, profile: string, description: string) => call<{ ok: boolean; description: string }>("PATCH", `${base(host)}/profiles/${encodeURIComponent(profile)}`, { description }),
  describeAuto: (host: string, profile: string, overwrite: boolean) => call<{ ok: boolean; reason: string | null; description: string }>("POST", `${base(host)}/profiles/${encodeURIComponent(profile)}/describe-auto`, { confirm: true, overwrite }),
  homes: (host: string, board: string | undefined, task: string) => call<{ home_channels: KbHome[] }>("GET", `${base(host)}/home-channels${q(board, task)}`),
  subscribe: (host: string, board: string | undefined, task: string, platform: string, on: boolean) =>
    call<{ ok: boolean }>(on ? "POST" : "DELETE", `${base(host)}/tasks/${encodeURIComponent(task)}/home-subscribe/${encodeURIComponent(platform)}${q(board)}`),
};
