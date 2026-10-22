import type { Decision, Profile } from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "X-Requested-With": "hermes-webui", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
    } catch { /* kein JSON */ }
    throw new ApiError(res.status, detail);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const p = (profile: string) => `/bff/p/${encodeURIComponent(profile)}`;

export const api = {
  profiles: () => call<{ profiles: Profile[] }>("GET", "/bff/profiles"),
  status: (profile: string) => call<{ online: boolean; capabilities?: Record<string, unknown>; error?: string }>("GET", `${p(profile)}/status`),
  models: (profile: string) => call<unknown>("GET", `${p(profile)}/models`),
  sessions: (profile: string) => call<unknown>("GET", `${p(profile)}/sessions`),
  messages: (profile: string, sid: string) => call<unknown>("GET", `${p(profile)}/sessions/${encodeURIComponent(sid)}/messages`),
  startRun: (profile: string, body: { text: string; session_id?: string; model?: string; images?: string[] }) =>
    call<{ run_id: string; session_id?: string }>("POST", `${p(profile)}/runs`, body),
  runStatus: (profile: string, rid: string) => call<{ status?: string }>("GET", `${p(profile)}/runs/${encodeURIComponent(rid)}`),
  stop: (profile: string, rid: string) => call<unknown>("POST", `${p(profile)}/runs/${encodeURIComponent(rid)}/stop`, {}),
  approve: (profile: string, rid: string, decision: Decision, approvalId?: string) =>
    call<unknown>("POST", `${p(profile)}/runs/${encodeURIComponent(rid)}/approval`, { decision, approval_id: approvalId }),
  clarify: (profile: string, rid: string, answer: string, clarifyId?: string) =>
    call<unknown>("POST", `${p(profile)}/runs/${encodeURIComponent(rid)}/clarify`, { answer, clarify_id: clarifyId }),
  eventsUrl: (profile: string, rid: string) => `${p(profile)}/runs/${encodeURIComponent(rid)}/events`,
};
