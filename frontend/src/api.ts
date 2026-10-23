import type { AgentRef, AgentStatus, Decision, DiagReport, HostsResponse, MemEntity, MemGraph, MemItem, MemModel, MemPage, MemProvider, Me, ProfileInput, SoulSaved, SoulState, SoulVersion, DashboardStatus, KeyCheck, ModelProvider, OAuthPoll, OAuthStart, ProviderMatrix, ProvidersOverview, Room, RoomMessage, ShaderConfig, UiConfig } from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public data?: Record<string, unknown>) {
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

export async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "X-Requested-With": "hermes-webui", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  if (!res.ok) {
    let detail = res.statusText;
    let code: string | undefined;
    let data: Record<string, unknown> | undefined;
    try {
      const j = await res.json();
      if (j.detail && typeof j.detail === "object") {
        code = j.detail.code;
        data = j.detail;
        detail = j.detail.message ?? JSON.stringify(j.detail);
      } else {
        detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
      }
    } catch { /* kein JSON */ }
    if (res.status === 401 && !code) toLogin();
    throw new ApiError(res.status, detail, code, data);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const mem = (p: string) => `/bff/memory/${encodeURIComponent(p)}`;
const qs = (o: Record<string, string | number | undefined>) => {
  const e = Object.entries(o).filter(([, v]) => v !== undefined && v !== "");
  return e.length ? `?${e.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")}` : "";
};

const base = (a: AgentRef) => `/bff/h/${encodeURIComponent(a.host)}/${encodeURIComponent(a.runtime)}/${encodeURIComponent(a.agent)}`;
const id = encodeURIComponent;

export const api = {
  me: () => call<Me>("GET", "/bff/me"),
  logout: () => call<void>("POST", "/auth/logout"),
  hosts: () => call<HostsResponse>("GET", "/bff/hosts"),
  ui: () => call<UiConfig>("GET", "/bff/ui"),
  saveProfile: (key: string, body: ProfileInput) =>
    call<UiConfig>("PUT", `/bff/ui/profiles/${key.split("/").map(encodeURIComponent).join("/")}`, body),
  saveShader: (body: ShaderConfig) => call<UiConfig>("PUT", "/bff/ui/shader", body),
  status: (a: AgentRef) => call<AgentStatus>("GET", `${base(a)}/status`),
  diagnose: (a: AgentRef) => call<DiagReport>("GET", `${base(a)}/diagnose`),
  diagnoseRun: (a: AgentRef) => call<DiagReport>("POST", `${base(a)}/diagnose/run`, {}),
  models: (a: AgentRef) => call<unknown>("GET", `${base(a)}/models`),
  // Die erste Seite in Standardgröße braucht keine Parameter (das BFF nimmt 30).
  sessions: (a: AgentRef, offset = 0, limit = 30) =>
    call<unknown>("GET", `${base(a)}/sessions${offset || limit !== 30 ? `?limit=${limit}&offset=${offset}` : ""}`),
  renameSession: (a: AgentRef, sid: string, title: string) => call<unknown>("PATCH", `${base(a)}/sessions/${id(sid)}`, { title }),
  deleteSession: (a: AgentRef, sid: string) => call<unknown>("DELETE", `${base(a)}/sessions/${id(sid)}`),
  messages: (a: AgentRef, sid: string) => call<unknown>("GET", `${base(a)}/sessions/${id(sid)}/messages`),
  startRun: (a: AgentRef, body: { text: string; session_id?: string; model?: string; images?: string[]; idempotency_key?: string }) =>
    call<{ run_id: string; session_id?: string | null }>("POST", `${base(a)}/runs`, body),
  fork: (a: AgentRef, sid: string) => call<{ session_id: string }>("POST", `${base(a)}/sessions/${id(sid)}/fork`, {}),
  runStatus: (a: AgentRef, rid: string) => call<{ status?: string }>("GET", `${base(a)}/runs/${id(rid)}`),
  stop: (a: AgentRef, rid: string) => call<unknown>("POST", `${base(a)}/runs/${id(rid)}/stop`, {}),
  approve: (a: AgentRef, rid: string, decision: Decision) =>
    call<unknown>("POST", `${base(a)}/runs/${id(rid)}/approval`, { decision }),
  steer: (a: AgentRef, rid: string, text: string) =>
    call<unknown>("POST", `${base(a)}/runs/${id(rid)}/steer`, { text }),
  clarify: (a: AgentRef, rid: string, answer: string, clarifyId?: string) =>
    call<unknown>("POST", `${base(a)}/runs/${id(rid)}/clarify`, { answer, clarify_id: clarifyId }),
  dashboard: (a: AgentRef) => call<DashboardStatus>("GET", `${base(a)}/dashboard`),
  soul: (a: AgentRef) => call<SoulState>("GET", `${base(a)}/soul`),
  saveSoul: (a: AgentRef, content: string, baseHash: string) => call<SoulSaved>("PUT", `${base(a)}/soul`, { content, base: baseHash }),
  soulVersion: (a: AgentRef, vid: string) => call<SoulVersion>("GET", `${base(a)}/soul/history/${id(vid)}`),
  restoreSoul: (a: AgentRef, vid: string) => call<SoulSaved & { content: string }>("POST", `${base(a)}/soul/restore`, { id: vid }),
  saveDescription: (a: AgentRef, description: string) => call<{ ok: boolean; description: string }>("PUT", `${base(a)}/profile/description`, { description }),
  providerMatrix: (host: string, runtime: string) => call<ProviderMatrix>("GET", `/bff/h/${encodeURIComponent(host)}/${encodeURIComponent(runtime)}/_provider-matrix`),
  profileModels: (a: AgentRef) => call<{ providers: ModelProvider[] }>("GET", `${base(a)}/providers/models`),
  oauthStart: (a: AgentRef, provider: string) => call<OAuthStart>("POST", `${base(a)}/providers/oauth/${encodeURIComponent(provider)}/start`),
  oauthPoll: (a: AgentRef, provider: string, session: string) => call<OAuthPoll>("GET", `${base(a)}/providers/oauth/${encodeURIComponent(provider)}/poll/${encodeURIComponent(session)}`),
  oauthSubmit: (a: AgentRef, provider: string, session: string, code: string) => call<{ ok?: boolean; status?: string }>("POST", `${base(a)}/providers/oauth/${encodeURIComponent(provider)}/submit`, { session_id: session, code }),
  saveModel: (a: AgentRef, provider: string, model: string) => call<{ ok: boolean }>("PUT", `${base(a)}/profile/model`, { provider, model }),
  providers: (a: AgentRef, days: number) => call<ProvidersOverview>("GET", `${base(a)}/providers?days=${days}`),
  validateKey: (a: AgentRef, varName: string, value: string) => call<KeyCheck>("POST", `${base(a)}/providers/validate`, { var: varName, value }),
  saveKey: (a: AgentRef, varName: string, value: string) => call<{ ok: boolean }>("PUT", `${base(a)}/providers/key`, { var: varName, value }),
  skills: (a: AgentRef) => call<unknown>("GET", `${base(a)}/skills`),
  toolsets: (a: AgentRef) => call<unknown>("GET", `${base(a)}/toolsets`),
  memoryProviders: () => call<{ providers: MemProvider[]; config_error: string | null }>("GET", "/bff/memory"),
  memoryStats: (p: string) => call<{ counts: Array<{ key: string; value: number }> }>("GET", `${mem(p)}/stats`),
  memoryItems: (p: string, o: { q?: string; kind?: string; limit?: number; offset?: number }) => call<MemPage>("GET", `${mem(p)}/items${qs(o)}`),
  memorySearch: (p: string, q: string, kind?: string) => call<{ items: MemItem[] }>("GET", `${mem(p)}/search${qs({ q, kind })}`),
  memoryGraph: (p: string, o: { q?: string; limit?: number } = {}) => call<MemGraph>("GET", `${mem(p)}/graph${qs(o)}`),
  memoryEntities: (p: string, o: { limit?: number; offset?: number } = {}) => call<{ items: MemEntity[]; total: number | null }>("GET", `${mem(p)}/entities${qs(o)}`),
  memoryEntity: (p: string, id: string) => call<MemEntity & { observations: MemItem[] }>("GET", `${mem(p)}/entities/${encodeURIComponent(id)}`),
  memoryModels: (p: string) => call<{ items: MemModel[] }>("GET", `${mem(p)}/models`),
  memoryReflect: (p: string, query: string) => call<{ text: string; based_on: MemItem[] }>("POST", `${mem(p)}/reflect`, { query }),
  memoryDiagnose: (p: string) => call<DiagReport>("GET", `${mem(p)}/diagnose`),
  rooms: (archived = false) => call<{ rooms: Room[] }>("GET", `/bff/rooms${archived ? "?archived=true" : ""}`),
  createRoom: (name: string, members: AgentRef[]) => call<Room>("POST", "/bff/rooms", { name, members }),
  room: (rid: string) => call<Room>("GET", `/bff/rooms/${id(rid)}`),
  patchRoom: (rid: string, patch: { name?: string; archived?: boolean }) => call<Room>("PATCH", `/bff/rooms/${id(rid)}`, patch),
  sendRoomMessage: (rid: string, text: string) => call<{ message: RoomMessage }>("POST", `/bff/rooms/${id(rid)}/messages`, { text }),
  stopRoom: (rid: string) => call<{ stopped: boolean }>("POST", `/bff/rooms/${id(rid)}/stop`, {}),
  roomEventsUrl: (rid: string) => `/bff/rooms/${id(rid)}/events`,
  eventsUrl: (a: AgentRef, rid: string) => `${base(a)}/runs/${id(rid)}/events`,
};
