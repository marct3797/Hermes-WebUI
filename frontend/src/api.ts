import { invalidate } from "./dataCache";
import type { AgentRef, AgentStatus, CliAuth, Decision, DiagReport, HostsResponse, KnowledgeDocs, KnowledgeHit, KnowledgeProvider, KnowledgeSources, KnowledgeStats, MemEntity, MemGraph, MemSeries, MemItem, MemModel, MemPage, MemProvider, Me, ProfileInput, SoulSaved, SoulState, SoulVersion, DashboardStatus, KeyCheck, ModelProvider, OAuthPoll, OAuthStart, ProviderMatrix, ProvidersOverview, Quota, QuotaSummary, Room, RoomMessage, ShaderConfig, UiConfig } from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public data?: Record<string, unknown>) {
    super(message);
  }
}

let redirecting = false;

/** Seitenwechsel mit Neuladen (Anmeldung, Abmeldung). Ein Objekt, damit Tests es ersetzen können. */
export const page = { assign: (url: string) => location.assign(url) };

/** Sitzung abgelaufen: einmal zum Anmeldedienst, danach zurück auf die aktuelle Seite. */
export function toLogin(stepUp = false) {
  if (redirecting) return;
  redirecting = true;
  const next = encodeURIComponent(location.pathname + location.search);
  page.assign(`/auth/login?next=${next}${stepUp ? "&step_up=true" : ""}`);
}

/** Nur für Tests: erlaubt einen weiteren Redirect. */
export const resetRedirect = () => { redirecting = false; };

export async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "X-Requested-With": "hermes-webui", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
    signal,
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

const kn = (p: string) => `/bff/knowledge/${encodeURIComponent(p)}`;
const mem = (p: string) => `/bff/memory/${encodeURIComponent(p)}`;
const qs = (o: Record<string, string | number | boolean | string[] | undefined>) => {
  const e = Object.entries(o).flatMap(([k, v]) => (v === undefined || v === "" || v === false ? [] : (Array.isArray(v) ? v : [v]).map((x) => `${k}=${encodeURIComponent(String(x === true ? 1 : x))}`)));
  return e.length ? `?${e.join("&")}` : "";
};

const base = (a: AgentRef) => `/bff/h/${encodeURIComponent(a.host)}/${encodeURIComponent(a.runtime)}/${encodeURIComponent(a.agent)}`;
const id = encodeURIComponent;
/** Nach Schreibzugriffen auf Sessions sind die zwischengespeicherten Listen (Cockpit) veraltet. */
const dropSessions = () => invalidate("sessions:");

export const api = {
  me: () => call<Me>("GET", "/bff/me"),
  logout: () => call<void>("POST", "/auth/logout"),
  hosts: (signal?: AbortSignal) => call<HostsResponse>("GET", "/bff/hosts", undefined, signal),
  ui: (signal?: AbortSignal) => call<UiConfig>("GET", "/bff/ui", undefined, signal),
  saveProfile: (key: string, body: ProfileInput) =>
    call<UiConfig>("PUT", `/bff/ui/profiles/${key.split("/").map(encodeURIComponent).join("/")}`, body),
  saveShader: (body: ShaderConfig) => call<UiConfig>("PUT", "/bff/ui/shader", body),
  status: (a: AgentRef) => call<AgentStatus>("GET", `${base(a)}/status`),
  diagnose: (a: AgentRef) => call<DiagReport>("GET", `${base(a)}/diagnose`),
  diagnoseRun: (a: AgentRef) => call<DiagReport>("POST", `${base(a)}/diagnose/run`, {}),
  models: (a: AgentRef) => call<unknown>("GET", `${base(a)}/models`),
  // Die erste Seite in Standardgröße braucht keine Parameter (das BFF nimmt 30).
  sessions: (a: AgentRef, offset = 0, limit = 30, signal?: AbortSignal) =>
    call<unknown>("GET", `${base(a)}/sessions${offset || limit !== 30 ? `?limit=${limit}&offset=${offset}` : ""}`, undefined, signal),
  renameSession: (a: AgentRef, sid: string, title: string) => call<unknown>("PATCH", `${base(a)}/sessions/${id(sid)}`, { title }).finally(dropSessions),
  deleteSession: (a: AgentRef, sid: string) => call<unknown>("DELETE", `${base(a)}/sessions/${id(sid)}`).finally(dropSessions),
  messages: (a: AgentRef, sid: string) => call<unknown>("GET", `${base(a)}/sessions/${id(sid)}/messages`),
  startRun: (a: AgentRef, body: { text: string; session_id?: string; model?: string; images?: string[]; idempotency_key?: string }) =>
    call<{ run_id: string; session_id?: string | null }>("POST", `${base(a)}/runs`, body).finally(dropSessions),
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
  cliAuth: (host: string) => call<CliAuth>("GET", `/bff/h/${encodeURIComponent(host)}/_cli-auth`),
  cliAuthRefresh: (host: string) => call<CliAuth>("POST", `/bff/h/${encodeURIComponent(host)}/_cli-auth/refresh`),
  quota: (a: AgentRef, refresh = false) => call<Quota>("GET", `${base(a)}/quota${refresh ? "?refresh=1" : ""}`),
  runtimeQuota: (host: string, runtime: string, refresh = false) => call<{ profiles: Record<string, Quota> }>("GET", `/bff/h/${encodeURIComponent(host)}/${encodeURIComponent(runtime)}/_quota${refresh ? "?refresh=1" : ""}`),
  quotaSummary: () => call<QuotaSummary>("GET", "/bff/quota/summary"),
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
  memoryGraph: (p: string, o: { type?: string; q?: string; limit?: number; tags?: string[]; tags_match?: string; refresh?: boolean } = {}) => call<MemGraph>("GET", `${mem(p)}/graph${qs(o)}`),
  memoryTimeseries: (p: string, o: { type?: string; period?: string } = {}) => call<MemSeries>("GET", `${mem(p)}/timeseries${qs(o)}`),
  memoryEntities: (p: string, o: { limit?: number; offset?: number } = {}) => call<{ items: MemEntity[]; total: number | null }>("GET", `${mem(p)}/entities${qs(o)}`),
  memoryEntity: (p: string, id: string) => call<MemEntity & { observations: MemItem[] }>("GET", `${mem(p)}/entities/${encodeURIComponent(id)}`),
  memoryModels: (p: string) => call<{ items: MemModel[] }>("GET", `${mem(p)}/models`),
  memoryReflect: (p: string, query: string) => call<{ text: string; based_on: MemItem[] }>("POST", `${mem(p)}/reflect`, { query }),
  memoryDiagnose: (p: string) => call<DiagReport>("GET", `${mem(p)}/diagnose`),
  knowledgeProviders: () => call<{ providers: KnowledgeProvider[]; config_error: string | null }>("GET", "/bff/knowledge"),
  knowledgeStats: (p: string) => call<KnowledgeStats>("GET", `${kn(p)}/stats`),
  knowledgeSources: (p: string) => call<KnowledgeSources>("GET", `${kn(p)}/sources`),
  knowledgeDocuments: (p: string, o: { source?: string; q?: string; limit?: number; offset?: number }) => call<KnowledgeDocs>("GET", `${kn(p)}/documents${qs(o)}`),
  knowledgeSearch: (p: string, body: { query: string; top_k: number; source?: string }) => call<{ results: KnowledgeHit[] }>("POST", `${kn(p)}/search`, body),
  knowledgeIngest: (p: string, body: { title: string; text: string; source?: string }) => call<{ ok: boolean; sync_id: string }>("POST", `${kn(p)}/ingest`, body),
  knowledgeDelete: (p: string, syncId: string) => call<{ ok: boolean; deleted?: number }>("POST", `${kn(p)}/delete`, { sync_id: syncId }),
  rooms: (archived = false) => call<{ rooms: Room[] }>("GET", `/bff/rooms${archived ? "?archived=true" : ""}`),
  createRoom: (name: string, members: AgentRef[]) => call<Room>("POST", "/bff/rooms", { name, members }),
  room: (rid: string) => call<Room>("GET", `/bff/rooms/${id(rid)}`),
  patchRoom: (rid: string, patch: { name?: string; archived?: boolean }) => call<Room>("PATCH", `/bff/rooms/${id(rid)}`, patch),
  sendRoomMessage: (rid: string, text: string) => call<{ message: RoomMessage }>("POST", `/bff/rooms/${id(rid)}/messages`, { text }),
  stopRoom: (rid: string) => call<{ stopped: boolean }>("POST", `/bff/rooms/${id(rid)}/stop`, {}),
  roomEventsUrl: (rid: string) => `/bff/rooms/${id(rid)}/events`,
  eventsUrl: (a: AgentRef, rid: string) => `${base(a)}/runs/${id(rid)}/events`,
};
