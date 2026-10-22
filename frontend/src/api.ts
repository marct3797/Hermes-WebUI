import type { AgentRef, AgentStatus, Decision, HostsResponse, Me, UiConfig } from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

let redirecting = false;

/** Seitenwechsel mit Neuladen (Anmeldung, Abmeldung). Ein Objekt, damit Tests es ersetzen können. */
export const page = { assign: (url: string) => location.assign(url) };

/** Sitzung abgelaufen: einmal zu Forgejo, danach zurück auf die aktuelle Seite. */
export function toLogin(stepUp = false) {
  if (redirecting) return;
  redirecting = true;
  const next = encodeURIComponent(location.pathname + location.search);
  page.assign(`/auth/login?next=${next}${stepUp ? "&step_up=true" : ""}`);
}

/** Nur für Tests: erlaubt einen weiteren Redirect. */
export const resetRedirect = () => { redirecting = false; };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "X-Requested-With": "hermes-webui", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  if (!res.ok) {
    let detail = res.statusText;
    let code: string | undefined;
    try {
      const j = await res.json();
      if (j.detail && typeof j.detail === "object") {
        code = j.detail.code;
        detail = j.detail.message ?? JSON.stringify(j.detail);
      } else {
        detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
      }
    } catch { /* kein JSON */ }
    if (res.status === 401 && !code) toLogin();
    throw new ApiError(res.status, detail, code);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const base = (a: AgentRef) => `/bff/h/${encodeURIComponent(a.host)}/${encodeURIComponent(a.runtime)}/${encodeURIComponent(a.agent)}`;
const id = encodeURIComponent;

export const api = {
  me: () => call<Me>("GET", "/bff/me"),
  logout: () => call<void>("POST", "/auth/logout"),
  hosts: () => call<HostsResponse>("GET", "/bff/hosts"),
  ui: () => call<UiConfig>("GET", "/bff/ui"),
  status: (a: AgentRef) => call<AgentStatus>("GET", `${base(a)}/status`),
  models: (a: AgentRef) => call<unknown>("GET", `${base(a)}/models`),
  sessions: (a: AgentRef) => call<unknown>("GET", `${base(a)}/sessions`),
  messages: (a: AgentRef, sid: string) => call<unknown>("GET", `${base(a)}/sessions/${id(sid)}/messages`),
  startRun: (a: AgentRef, body: { text: string; session_id?: string; model?: string; images?: string[] }) =>
    call<{ run_id: string; session_id?: string | null }>("POST", `${base(a)}/runs`, body),
  runStatus: (a: AgentRef, rid: string) => call<{ status?: string }>("GET", `${base(a)}/runs/${id(rid)}`),
  stop: (a: AgentRef, rid: string) => call<unknown>("POST", `${base(a)}/runs/${id(rid)}/stop`, {}),
  approve: (a: AgentRef, rid: string, decision: Decision) =>
    call<unknown>("POST", `${base(a)}/runs/${id(rid)}/approval`, { decision }),
  steer: (a: AgentRef, rid: string, text: string) =>
    call<unknown>("POST", `${base(a)}/runs/${id(rid)}/steer`, { text }),
  clarify: (a: AgentRef, rid: string, answer: string, clarifyId?: string) =>
    call<unknown>("POST", `${base(a)}/runs/${id(rid)}/clarify`, { answer, clarify_id: clarifyId }),
  eventsUrl: (a: AgentRef, rid: string) => `${base(a)}/runs/${id(rid)}/events`,
};
