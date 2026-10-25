import { act } from "@testing-library/react";
import { vi } from "vitest";
import quotaFixture from "./fixtures/quota_laptop.json";
import graphFixture from "./fixtures/bff_graph_world.json";
import ragStats from "./fixtures/real/rag_stats_clean.json";
import ragQuery from "./fixtures/real/rag_query_clean.json";
import chromaGet from "./fixtures/real/chroma_get_clean.json";
import { invalidate } from "./dataCache";
import type { HostInfo, KnowledgeProvider, MemGraph, ProfileInput, Room, RoomEvent, SigilConfig, StreamEvent, UiConfig } from "./types";

/** Gemeinsame Test-Attrappen: BFF-Antworten und EventSource für die Seiten-Tests. */

export const hostsFor = (agents: string[]): HostInfo[] => [
  { id: "server", label: "Server", kind: "local", address: null, status: "online", detail: null, runtimes: [
    { id: "hermes", label: "Hermes", status: "online", version: "0.21.6", detail: null, multiplex: true, agents: agents.map((id) => ({ id, label: id })) }] },
  { id: "laptop", label: "Laptop", kind: "remote", address: "100.64.3.4", status: "unreachable", detail: "Host-Dienst nicht verbunden", runtimes: [
    { id: "hermes", label: "Hermes", status: "unreachable", version: null, detail: "Host-Dienst nicht verbunden", multiplex: false, agents: [{ id: "default", label: "default" }] }] },
];

export class FakeEventSource {
  static all: FakeEventSource[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeEventSource.all.push(this); }
  close() { this.closed = true; }
}

/** Ereignis auf einem Stream auslösen; ohne Index der zuletzt geöffnete, sonst der Stream, dessen URL den Agent nennt. */
export function emit(ev: StreamEvent, agent?: string) {
  const list = FakeEventSource.all;
  const es = agent ? [...list].reverse().find((s) => s.url.includes(`/${agent}/runs/`)) : list[list.length - 1];
  act(() => { es?.onmessage?.(new MessageEvent("message", { data: JSON.stringify(ev) })); });
}

/** Raum-Ereignis auf dem Strom des Raums auslösen. */
export function emitRoom(ev: RoomEvent) {
  const es = [...FakeEventSource.all].reverse().find((s) => s.url.includes("/bff/rooms/"));
  act(() => { es?.onmessage?.(new MessageEvent("message", { data: JSON.stringify(ev) })); });
}

export const roomOf = (id: string, name: string, agents: string[], extra: Partial<Room> = {}): Room => ({
  id, name, archived: false, needs_user: false, created_at: 1_792_000_000, running: false, speaker: null, asks: [],
  members: agents.map((a) => ({ host: "server", runtime: "hermes", agent: a, label: a, key: `server/hermes/${a}` })), ...extra,
});

export type Call = { method: string; url: string; body?: Record<string, unknown> };

/** Standard-Config der Attrappe: Shader aus (jsdom hat kein WebGL), Config nicht schreibbar. */
export const baseUi = (): UiConfig => ({
  ui: { backgroundShader: { enabled: false, strength: 1, speed: 1 } }, sigils: {}, labels: {}, packs: {},
  writable: false, write_error: "Die ui.json ist für die WebUI schreibgeschützt.", warnings: [], error: null,
});

/** Verlauf einer Session in Hermes' Form: Tool-Aufruf als `tool_calls`, Ergebnis als Nachricht mit Rolle `tool`. */
export function sessionMessages(_path: string) {
  return [
    { id: 1, role: "user", content: "Was liegt im Ordner?", timestamp: 1_792_000_000 },
    { id: 2, role: "assistant", content: "", reasoning: "Ich sehe nach.", tool_calls: [{ id: "call_1", type: "function", function: { name: "terminal", arguments: "{\"command\":\"ls\"}" } }] },
    { id: 3, role: "tool", tool_call_id: "call_1", tool_name: "terminal", content: JSON.stringify({ output: "notes.txt", exit_code: 0 }) },
    { id: 4, role: "assistant", content: "Dort liegt notes.txt." },
  ];
}

const diag = (agent: string, withRun = false) => ({
  agent: `server/hermes/${agent}`, status: withRun ? "warn" : "ok", at: 1_792_000_000,
  checks: withRun
    ? [{ id: "run.start", label: "Run starten", status: "ok", detail: "Run run_1", ms: 12 }, { id: "run.stream", label: "Ereignisstrom bis zum Abschluss", status: "warn", detail: "Antwort kam ohne Zeichenstrom", ms: 80 }]
    : [{ id: "health", label: "Erreichbar und angemeldet", status: "ok", detail: "Version 0.21.6", ms: 5 }, { id: "models", label: "Modelle und Anbieter", status: "ok", detail: "1 Anbieter, 2 Modelle", ms: 9 }],
});

const memItem = (id: string, text: string, kind: string, entities: string[] = []) => ({ id, text, kind, context: null, entities, at: 1_792_000_000_000, tags: [], document: null });
const MEM_ITEMS = [
  memItem("f1", "Alex betreibt einen Server namens Server.", "world", ["Alex", "Server"]),
  memItem("f2", "Alex hat die WebUI gebaut.", "experience", ["Alex"]),
  memItem("f3", "Server läuft im Tailnet.", "world", ["Server"]),
];

const GRAPH_WORLD = graphFixture as unknown as MemGraph;

/** Gedächtnis-Routen des BFF in Hindsights Form (nach der Normalisierung durch das BFF). */
function memoryRoute(url: string, method: string, capabilities: string[], json: (b: unknown, s?: number) => Response, body?: Record<string, unknown>): Response | undefined {
  const u = new URL(url, "http://bff");
  const path = u.pathname;
  if (path === "/bff/memory") return json({ providers: [{ id: "hindsight", type: "hindsight", label: "Hindsight", bank: "hermes", capabilities }], config_error: null });
  const m = /^\/bff\/memory\/hindsight\/([a-z]+)(?:\/(.+))?$/.exec(path);
  if (!m) return undefined;
  const [, what, rest] = m;
  const q = u.searchParams.get("q") ?? "";
  if (what === "stats") return json({ counts: [{ key: "total_nodes", value: 120 }, { key: "pending_operations", value: 0 }, { key: "nodes_by_fact_type.world", value: 80 }, { key: "nodes_by_fact_type.experience", value: 40 }] });
  if (what === "items") {
    const kind = u.searchParams.get("kind");
    const offset = Number(u.searchParams.get("offset") ?? 0);
    const rows = MEM_ITEMS.filter((i) => (!kind || i.kind === kind) && (!q || i.text.includes(q)));
    return json({ items: rows.slice(offset, offset + 2), total: rows.length, limit: 2, offset });
  }
  if (what === "search") return json({ items: MEM_ITEMS.filter((i) => i.text.toLowerCase().includes(q.toLowerCase())) });
  if (what === "graph") {
    if (q === "leer") return json({ ...GRAPH_WORLD, nodes: [], edges: [], table_rows: [], total: 0, returned: 0, truncated: false, edges_dropped: 0 });
    const type = u.searchParams.get("type") ?? "world", limit = Number(u.searchParams.get("limit") ?? 500);
    // Antwort in der Form, die das BFF aus der echten Hindsight-Antwort macht (fixtures/bff_graph_world.json); `total` täuscht ein großes Gedächtnis vor.
    const nodes = GRAPH_WORLD.nodes.slice(0, limit).map((n) => ({ ...n, kind: type }));
    return json({ ...GRAPH_WORLD, nodes, table_rows: GRAPH_WORLD.table_rows.slice(0, limit).map((r) => ({ ...r, kind: type })), limit, returned: nodes.length, total: 44272 });
  }
  if (what === "timeseries") return json({ points: [{ t: "2026-10-21T00:00:00+00:00", count: 3 }, { t: "2026-10-22T00:00:00+00:00", count: 9 }, { t: "2026-10-23T00:00:00+00:00", count: 25 }] });
  if (what === "entities" && rest) return json({ id: rest, name: "Alex", mentions: 7, first_seen: null, last_seen: 1_792_000_000_000, observations: [MEM_ITEMS[1]] });
  if (what === "entities") return json({ items: [{ id: "e1", name: "Alex", mentions: 7, first_seen: null, last_seen: null }, { id: "e2", name: "Server", mentions: 4, first_seen: null, last_seen: null }], total: 2 });
  if (what === "models") return json({ items: [{ id: "m1", name: "Zuhause", content: "**Netz:** Tailscale", query: "Wie sieht das Netz aus?", updated: 1_792_000_000_000, tags: ["netz"] }] });
  if (what === "diagnose") return json({ agent: "Gedächtnis/hindsight", status: "warn", checks: [{ id: "reach", label: "Erreichbar", status: "ok", detail: "Bank hermes", ms: 7 }, { id: "shape", label: "Antwortform", status: "warn", detail: "Graph ohne Kantenbeschriftung", ms: 9 }] });
  if (what === "reflect" && method === "POST") return json({ text: `Antwort auf: ${String(body?.query)}`, based_on: [MEM_ITEMS[0]] });
  return json({ detail: "nicht da" }, 404);
}

/** Zustand der Wissens-Attrappe; Tests ändern ihn direkt (z. B. `kn.stepUp`, `kn.searchError`). */
export type KnowledgeState = { available: boolean; truncated: boolean; stepUp: boolean; statsError: string | null; searchError: string | null; docs: Array<Record<string, unknown>> };

const LINK = "https://git.example.com/{repo}/src/commit/{commit}/{path}";

/** Dokumente aus den echten Chroma-Zeilen (fixtures/real/chroma_get_clean.json), je `sync_id` ein Dokument. */
function knowledgeDocs(): KnowledgeState["docs"] {
  const by = new Map<string, Record<string, unknown>>();
  for (const m of chromaGet.metadatas as unknown as Array<Record<string, string>>) {
    const d = by.get(m.sync_id) ?? { sync_id: m.sync_id, source: m.source, repo: m.repo ?? null, path: m.path ?? null, commit: m.commit ?? null, chunks: 0, title: m.title ?? null };
    d.chunks = (d.chunks as number) + 1;
    by.set(m.sync_id, d);
  }
  return [...by.values()].sort((a, b) => String(a.sync_id).localeCompare(String(b.sync_id)));
}

function knowledgeRoute(url: string, method: string, kn: KnowledgeState, providers: KnowledgeProvider[], json: (b: unknown, s?: number) => Response, body?: Record<string, unknown>): Response | undefined {
  const u = new URL(url, "http://bff");
  if (u.pathname === "/bff/knowledge") return json({ providers, config_error: null });
  const m = /^\/bff\/knowledge\/([a-z0-9_-]+)\/([a-z]+)$/.exec(u.pathname);
  if (!m) return undefined;
  const what = m[2];
  const sourceRows = () => {
    const by = new Map<string, { source: string; chunks: number; documents: number; repos: Set<string> }>();
    for (const d of kn.docs) {
      const s = by.get(d.source as string) ?? { source: d.source as string, chunks: 0, documents: 0, repos: new Set<string>() };
      s.chunks += d.chunks as number; s.documents += 1; if (d.repo) s.repos.add(d.repo as string);
      by.set(s.source, s);
    }
    return [...by.values()].map((s) => ({ ...s, repos: [...s.repos] }));
  };
  if (what === "stats") {
    if (kn.statsError) return json({ reachable: false, reason: kn.statsError });
    return json({ reachable: true, ...ragStats, count: 7047, documents: kn.available ? kn.docs.length : null, sources: kn.available ? sourceRows().length : null });
  }
  if (what === "sources") {
    if (!kn.available) return json({ available: false, reason: "Keine chroma_url konfiguriert.", items: [], scanned_chunks: 0, truncated: false, cache_age_s: 0 });
    return json({ available: true, reason: null, items: sourceRows(), scanned_chunks: 10, truncated: kn.truncated, cache_age_s: 0 });
  }
  if (what === "documents") {
    if (!kn.available) return json({ available: false, reason: "Keine chroma_url konfiguriert.", items: [], total: 0 });
    const src = u.searchParams.get("source"), q = (u.searchParams.get("q") ?? "").toLowerCase();
    const rows = kn.docs.filter((d) => (!src || d.source === src) && (!q || [d.sync_id, d.path, d.title].some((x) => String(x ?? "").toLowerCase().includes(q))));
    const offset = Number(u.searchParams.get("offset") ?? 0), limit = Number(u.searchParams.get("limit") ?? 100);
    return json({ available: true, reason: null, items: rows.slice(offset, offset + limit), total: rows.length });
  }
  if (what === "search" && method === "POST") {
    if (kn.searchError) return json({ detail: kn.searchError }, 502);
    const results = (String(body?.query).includes("nichts") ? [] : ragQuery.results).filter((r) => !body?.source || r.metadata.source === body.source).map((r) => ({
      text: r.content, score: r.score, ...r.metadata, url: LINK.replace("{repo}", r.metadata.repo).replace("{commit}", r.metadata.commit).replace("{path}", r.metadata.path),
    }));
    return json({ results: results.map((r, i) => (i === 1 ? { ...r, url: null } : r)) }); // der zweite Treffer hat keinen Link
  }
  if ((what === "ingest" || what === "delete") && method === "POST") {
    if (kn.stepUp) return json({ detail: { code: "step_up_required", message: "Bitte erneut anmelden" } }, 401);
    if (what === "delete") { kn.docs = kn.docs.filter((d) => d.sync_id !== body?.sync_id); return json({ ok: true, deleted: 1 }); }
    const sync_id = `manual:${String(body?.title).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    if (kn.docs.some((d) => d.sync_id === sync_id)) return json({ detail: `Es gibt schon ein Dokument mit der Kennung ${sync_id}.` }, 409);
    kn.docs.push({ sync_id, source: "manual", repo: null, path: null, commit: null, chunks: 1, title: body?.title });
    return json({ ok: true, source: "manual", sync_id, title: body?.title });
  }
  return json({ detail: "nicht da" }, 404);
}

/** Das Dashboard hinter dem BFF: SOUL mit Verlauf. Tests ändern den Zustand direkt (z. B. `dash.soul` für einen Konflikt). */
export type DashState = {
  available: boolean; reason: string | null; soul: string; description: string; model: { provider: string; model: string };
  history: Array<{ id: string; at: string; reason: string; chars: number }>; versions: Record<string, string>; stepUp: boolean;
  keys: Record<string, string>; // gesetzte Anbieter-Keys (Variable → Wert); der Wert verlässt die Attrappe nie
  loggedIn: Set<string>; // Anbieter mit Anmeldung (Codex ist von Anfang an angemeldet)
  polls: number; // wie oft die laufende Geräte-Anmeldung abgefragt wurde; ab der zweiten Abfrage ist sie bestätigt
  loginError: string | null; // lässt die Anmeldung scheitern
  config: Record<string, unknown>; // Werte der Hermes-Einstellungen (Punkt-Pfad → Wert)
  msg: { available: boolean; enabled: Record<string, boolean>; env: Record<string, string>; gateway: { running: boolean; busy: boolean; sessions: number }; polls: number; applied: string[] }; // Messaging und Gateway
  hm: { available: boolean; active: string; files: { memory: number; user: number }; keySet: boolean; project: string; mode: string }; // Hermes-Gedächtnis
  tools: { available: boolean; enabled: Record<string, boolean>; keys: Record<string, string>; provider: Record<string, string>; model: string; installed: boolean }; // Werkzeug-Gruppen
  ac: { pending: Array<{ platform: string; request_id: string; user_id: string; user_name: string }>; approved: Array<{ platform: string; user_id: string; user_name: string }>; hooksOn: boolean; hooks: Array<{ name: string; enabled: boolean }> };
  mdDown?: boolean; mdFresh: boolean; // frische Installation: noch kein Anbieter, kein Modell (gültige, leere Antworten)
  sa: { down?: boolean; sessions: Array<{ id: string; ageDays: number; messages: number; active?: boolean }> };
  ep: { backend: string; endpoints: Array<{ id: string; name: string; base_url: string; model: string; hasKey: boolean }>; current: string };
  lcProfiles: string[]; lcActive: string; // Profil-Lebenszyklus: Namen als Text, nie Serverpfade
  p3: { pool: Array<{ provider: string; entries: Array<{ index: number; label: string; source: string; token_tail: string }> }>; voiceOn: boolean; paused: boolean; nodes: Record<string, string>; theme: string; font: string;
    metrics: { enabled: boolean; send: boolean; decided: boolean; managed: boolean }; unlocked: boolean; workers: Array<{ run_id: number; task_id: string }>; spawnNone?: boolean; stale?: boolean; };
};

const TOOL_CATALOG = [
  { name: "terminal", label: "Terminal", description: "Befehle ausführen.", tools: ["terminal"], providers: [] as Array<Record<string, unknown>> },
  { name: "web", label: "Web", description: "Suchen und Seiten lesen.", tools: ["web_search"], providers: [
    { name: "Brave Search (Free)", badge: "free", status: "needs_keys", capabilities: ["search"], env: [{ key: "BRAVE_SEARCH_API_KEY", prompt: "Brave Search API key", url: "https://brave.com/search/api/" }] },
    { name: "Firecrawl Cloud", badge: "paid", status: "needs_keys", capabilities: ["search", "extract"], env: [{ key: "FIRECRAWL_API_KEY", prompt: "Firecrawl API key", url: "javascript:alert(1)" }] }] },
  { name: "image_gen", label: "Bilder", description: "Bilder erzeugen.", tools: ["image_generate"], providers: [{ name: "FAL.ai", badge: "paid", status: "needs_keys", env: [{ key: "FAL_KEY", prompt: "FAL API key" }] }] },
  { name: "computer_use", label: "Computer Use", description: "Bildschirm steuern.", tools: ["computer_use"], providers: [{ name: "Cua Driver", badge: "local", status: "needs_setup", post_setup: "cua_driver", env: [] }] },
];
const MSG_CATALOG = [
  { id: "telegram", name: "Telegram", description: "Hermes über Telegram nutzen.", docs_url: "https://core.telegram.org/bots/features#botfather", vars: [
    { key: "TELEGRAM_BOT_TOKEN", required: true, is_password: true, prompt: "Bot token", url: "https://t.me/BotFather" }, { key: "TELEGRAM_ALLOWED_USERS", required: false, is_password: false, is_list: true, prompt: "Allowed user IDs" }] },
  { id: "discord", name: "Discord", description: "Hermes über Discord nutzen.", docs_url: "javascript:alert(1)", vars: [{ key: "DISCORD_BOT_TOKEN", required: true, is_password: true, prompt: "Bot token" }] },
  { id: "slack", name: "Slack", description: "Hermes über Slack nutzen.", docs_url: null, vars: [{ key: "SLACK_BOT_TOKEN", required: true, is_password: true, prompt: "Bot token" }] },
];
const stepUpBody = { detail: { code: "step_up_required", message: "Bitte erneut anmelden" } };
const hashOf = (text: string) => `h${text.length}:${text.slice(0, 12)}`;

const KEY_VARS: Array<[provider: string, label: string, varName: string]> = [
  ["anthropic", "Anthropic", "ANTHROPIC_API_KEY"], ["openrouter", "OpenRouter", "OPENROUTER_API_KEY"], ["gemini", "Google Gemini", "GEMINI_API_KEY"],
  ["opencode-go", "OpenCode Go", "OPENCODE_GO_API_KEY"],
];

/** Die drei Zugänge auf dem Host, wie das BFF sie für die Anbieter-Hauptseite liefert. */
const ACCOUNTS = [
  { id: "codex", label: "OpenAI Codex", cli: "codex", login: "device", provider: "openai-codex", hint: "Anmeldung mit dem ChatGPT-Konto per Gerätecode." },
  { id: "claude", label: "Claude", cli: "claude", login: "pkce", provider: "anthropic", hint: "API-Key oder Anmeldung über die Anthropic-Seite." },
  { id: "opencode-go", label: "OpenCode Go", cli: "opencode", login: "key", provider: "opencode-go", hint: "Zugang per API-Key." },
] as const;
const KEY_OF: Record<string, string> = { claude: "ANTHROPIC_API_KEY", "opencode-go": "OPENCODE_GO_API_KEY" };

function accountState(dash: DashState, id: string, provider: string) {
  if (dash.loggedIn.has(provider)) return { configured: true, via: "login", detail: provider === "openai-codex" ? "~/.codex/auth.json" : "Anmeldung" };
  const key = KEY_OF[id];
  if (key && key in dash.keys) return { configured: true, via: "key", detail: "sk-a…1234" };
  return { configured: false, via: null, detail: null };
}

/** Kontingente: die echte, bereinigte Antwort des Plugins (vom BFF normalisiert). `expired` lässt den OpenCode-Key des Profils „default“ ablaufen. */
export type QuotaMode = "ok" | "missing" | "expired" | "offline";
function quotaOf(profile: string, mode: QuotaMode) {
  const base = quotaFixture as unknown as { state: string; reason: string | null; generated_at: string; cached: boolean; providers: Array<Record<string, unknown>> };
  if (mode === "missing") return { ...base, state: "plugin_missing", reason: "Plugin ai-usage-tracker auf diesem Host nicht installiert", providers: [] };
  if (mode === "offline") return { ...base, state: "dashboard_unavailable", reason: "Das Dashboard ist nicht erreichbar", providers: [] };
  if (mode === "expired" && profile === "default") {
    return { ...base, providers: base.providers.map((p) => (p.id === "opencode-go" ? { ...p, state: "auth_failed", windows: [], worst_remaining_percent: null, reason: "HTTP 401 unauthorized: Key abgelaufen" } : p)) };
  }
  return base;
}
function quotaSummary(agents: string[], mode: QuotaMode) {
  const items = agents.flatMap((profile) => (quotaOf(profile, mode).providers as Array<{ id: string; label: string; state: string; windows: Array<{ label: string; remaining_percent: number; reset_in_s: number }> }>)
    .filter((p) => p.state === "auth_failed" || p.windows.length > 0)
    .map((p) => {
      const w = [...p.windows].sort((a, b) => a.remaining_percent - b.remaining_percent)[0];
      return { host: "server", runtime: "hermes", profile, provider: p.id, label: p.label, state: p.state, remaining_percent: w?.remaining_percent ?? null, window: w?.label ?? null, reset_in_s: w?.reset_in_s ?? null, reason: null };
    }));
  const rank = (i: { remaining_percent: number | null }) => i.remaining_percent ?? -1;
  return { runtimes: [{ host: "server", runtime: "hermes", state: mode === "missing" ? "plugin_missing" : mode === "offline" ? "dashboard_unavailable" : "ok", reason: mode === "ok" || mode === "expired" ? null : quotaOf("x", mode).reason }],
    items, worst: [...items].sort((a, b) => rank(a) - rank(b))[0] ?? null };
}

function providerMatrix(agents: string[], dash: DashState) {
  const profiles = agents.map((name) => ({ name, model: dash.available ? dash.model.model : null, provider: dash.available ? dash.model.provider : null, default: name === "default", gateway_running: true, error: null }));
  return {
    available: dash.available, reason: dash.reason, profiles,
    accounts: ACCOUNTS.map((a) => ({ ...a, profiles: dash.available ? Object.fromEntries(agents.map((n) => [n, accountState(dash, a.id, a.provider)])) : {} })),
  };
}

function providersOverview(dash: DashState, days: number) {
  const providers = KEY_VARS.map(([id, label, varName]) => {
    const set = varName in dash.keys;
    const usage = id === "anthropic" ? { sessions: 12, input_tokens: 1_200_000, output_tokens: 300_000, cost_usd: 4.5, last_used_at: 1_792_000_000, models: ["claude-test", "claude-test"] } : null;
    // Anthropic und Gemini bieten auch eine Anmeldung an, beide sind hier nicht angemeldet.
    const oauth = id === "openrouter" || id === "opencode-go" ? null : { logged_in: dash.loggedIn.has(id), flow: "pkce", source: null, expires_at: null, cli_command: `hermes auth add ${id}`, docs_url: null };
    return { id, label, configured: set, used: !!usage, oauth, usage,
      keys: [{ var: varName, set, redacted: set ? "«redacted»" : null, description: "", url: "https://example.invalid/keys", secret: true, advanced: false }] };
  });
  const codex = dash.loggedIn.has("openai-codex");
  providers.push({ id: "openai-codex", label: "OpenAI Codex", configured: codex, used: false, keys: [], usage: null,
    oauth: { logged_in: codex, flow: "device_code", source: "~/.codex/auth.json", expires_at: null, cli_command: "hermes auth add openai-codex", docs_url: null } } as never);
  providers.sort((a, b) => Number(b.configured) - Number(a.configured));
  return { providers, period_days: days, warnings: [] as string[] };
}

function dashboardRoute(rest: string, method: string, agent: string, dash: DashState, json: (b: unknown, s?: number) => Response, body?: Record<string, unknown>, init?: RequestInit): Response | undefined {
  if (rest === "/dashboard") {
    return json(dash.available
      ? { available: true, reason: null, profile: { name: agent, ...dash.model, description: dash.description, description_auto: false, skill_count: 12, gateway_running: false, has_env: true } }
      : { available: false, reason: dash.reason, profile: null });
  }
  const path = rest.split("?")[0];
  if (path === "/providers" && method === "GET") return json(providersOverview(dash, Number(new URL(rest, "http://bff").searchParams.get("days") ?? 30)));
  if (path === "/providers/models" && method === "GET") {
    return json({ providers: [
      { slug: dash.model.provider, name: dash.model.provider === "mock" ? "Mock" : dash.model.provider, current: true, authenticated: true, models: ["mock-large", "mock-small"], warning: null },
      { slug: "anthropic", name: "Anthropic", current: false, authenticated: dash.loggedIn.has("anthropic") || "ANTHROPIC_API_KEY" in dash.keys, models: ["claude-test", "claude-test-2"], warning: null },
      { slug: "openai-codex", name: "OpenAI Codex", current: false, authenticated: dash.loggedIn.has("openai-codex"), models: ["codex-test"], warning: null },
    ] });
  }
  const oauth = /^\/providers\/oauth\/([a-z0-9-]+)\/(start|submit|poll\/[A-Za-z0-9_-]+)$/.exec(path);
  if (oauth) {
    if (dash.stepUp && oauth[2] !== "poll") return json({ detail: { code: "step_up_required", message: "Bitte erneut anmelden" } }, 401);
    const [, provider, action] = oauth;
    if (action === "start") {
      dash.polls = 0;
      return json(provider === "anthropic"
        ? { session_id: "sess-pkce-0001", flow: "pkce", auth_url: "https://example.invalid/authorize?state=x", expires_in: 600 }
        : { session_id: "sess-device-0001", flow: "device_code", user_code: "ABCD-1234", verification_url: "https://example.invalid/device", expires_in: 900, poll_interval: 0.2 });
    }
    if (action === "submit") {
      const ok = body?.code === "gueltig";
      if (ok) dash.loggedIn.add(provider); else dash.loginError = "Der Code wurde abgelehnt.";
      return json({ ok, status: ok ? "approved" : "error" });
    }
    if (dash.loginError) return json({ session_id: "s", status: "error", error_message: dash.loginError, expires_at: null });
    dash.polls += 1;
    const approved = provider === "anthropic" ? dash.loggedIn.has(provider) : dash.polls >= 2;
    if (approved) dash.loggedIn.add(provider);
    return json({ session_id: "s", status: approved ? "approved" : "pending", error_message: dash.loginError, expires_at: null });
  }
  if (path === "/providers/validate" && method === "POST") {
    return json(body?.value === "bad" ? { ok: false, reachable: true, message: "Der Anbieter hat den Key abgelehnt." }
      : body?.value === "offline" ? { ok: false, reachable: false, message: "" } : { ok: true, reachable: true, message: "" });
  }
  if (path === "/providers/key" && method === "PUT") {
    if (dash.stepUp) return json({ detail: { code: "step_up_required", message: "Bitte erneut anmelden" } }, 401);
    dash.keys[String(body?.var)] = String(body?.value);
    return json({ ok: true, var: body?.var });
  }
  const snapshot = (reason: string) => {
    const id = `20261023T1700${String(dash.history.length).padStart(2, "0")}000000`;
    dash.versions[id] = dash.soul;
    dash.history = [{ id, at: "2026-10-23T17:00:00Z", reason, chars: dash.soul.length }, ...dash.history];
  };
  if (rest === "/config" && method === "GET") {
    const fields = [
      { key: "model", type: "string", description: "Default model", category: "general" },
      { key: "agent.service_tier", type: "select", description: "Fast mode", category: "agent", options: ["", "normal", "fast"] },
      { key: "agent.max_turns", type: "number", description: "Max turns", category: "agent" },
      { key: "display.streaming", type: "boolean", description: "Streaming", category: "display" },
      { key: "fallback_providers", type: "list", description: "Fallback providers", category: "general" },
    ].map((x) => ({ ...x, value: dash.config[x.key] }));
    return json({ fields: [...fields, { key: "web.api_key", type: "string", description: "Search key", category: "tools", secret: true, set: true, value: null }], category_order: ["general", "agent", "display", "tools"] });
  }
  if (rest === "/config" && method === "PUT") {
    if (dash.stepUp) return json({ detail: { code: "step_up_required", message: "Bitte erneut anmelden" } }, 401);
    if ("agent.max_turns" in (body?.changes as object) && (body?.changes as Record<string, unknown>)["agent.max_turns"] === 0) return json({ detail: "agent.max_turns: ungültiger Wert für Typ „number“" }, 422);
    Object.assign(dash.config, body?.changes);
    return json({ ok: true, changed: Object.keys(body?.changes as object).sort() });
  }
  if (rest === "/soul" && method === "GET") return json({ content: dash.soul, exists: true, hash: hashOf(dash.soul), max_chars: 100, history: dash.history });
  if (rest === "/soul" && method === "PUT") {
    if (dash.stepUp) return json({ detail: { code: "step_up_required", message: "Bitte erneut anmelden" } }, 401);
    if (body?.base !== hashOf(dash.soul)) return json({ detail: { code: "soul_changed", message: "SOUL.md wurde inzwischen geändert", current: dash.soul, hash: hashOf(dash.soul) } }, 409);
    const changed = body.content !== dash.soul;
    if (changed) { snapshot("vor Änderung"); dash.soul = String(body.content); }
    return json({ changed, hash: hashOf(dash.soul), history: dash.history });
  }
  const version = /^\/soul\/history\/(.+)$/.exec(rest);
  if (version && method === "GET") {
    const entry = dash.history.find((h) => h.id === version[1]);
    return entry ? json({ ...entry, content: dash.versions[entry.id] }) : json({ detail: "Dieser Stand existiert nicht" }, 404);
  }
  if (rest === "/soul/restore" && method === "POST") {
    if (dash.stepUp) return json({ detail: { code: "step_up_required", message: "Bitte erneut anmelden" } }, 401);
    const content = dash.versions[String(body?.id)];
    if (content === undefined) return json({ detail: "Dieser Stand existiert nicht" }, 404);
    snapshot("vor Wiederherstellung");
    dash.soul = content;
    return json({ changed: true, hash: hashOf(content), content, history: dash.history });
  }
  if (rest === "/profile/description" && method === "PUT") { dash.description = String(body?.description).trim(); return json({ ok: true, description: dash.description }); }
  if (rest === "/profile/model" && method === "PUT") { dash.model = { provider: String(body?.provider), model: String(body?.model) }; return json({ ok: true, ...dash.model }); }
  if (path.startsWith("/messaging") || path.startsWith("/gateway")) {
    if (!dash.msg.available) return json({ detail: "Für diesen Host ist kein Dashboard eingerichtet" }, 501);
    const m = dash.msg;
    const rows = () => MSG_CATALOG.map((p) => {
      const configured = p.vars.filter((v) => v.required).every((v) => v.key in m.env);
      const enabled = Boolean(m.enabled[p.id]);
      return { id: p.id, name: p.name, description: p.description, docs_url: p.docs_url, enabled, configured, gateway_running: m.gateway.running, home_channel_set: false,
        state: !enabled ? "disabled" : !configured ? "not_configured" : !m.gateway.running ? "gateway_stopped" : "connected", error_message: null,
        env_vars: p.vars.map((v) => ({ ...v, is_set: v.key in m.env, ...(v.is_password ? {} : { value: m.env[v.key] ?? "" }) })) };
    });
    if (path === "/messaging" && method === "GET") return json({ platforms: rows() });
    const put = /^\/messaging\/([a-z_]+)$/.exec(path);
    if (put && method === "PUT") {
      if (dash.stepUp) return json(stepUpBody, 401);
      const entry = MSG_CATALOG.find((p) => p.id === put[1]);
      if (!entry) return json({ detail: "Unbekannte Plattform" }, 404);
      const env = (body?.env ?? {}) as Record<string, string>;
      if (Object.values(env).includes("kein-token")) return json({ detail: "Das Dashboard meldet Fehler 400: Telegram bot token must be the complete token from @BotFather" }, 502);
      Object.assign(m.env, env);
      for (const k of (body?.clear_env ?? []) as string[]) delete m.env[k];
      if (typeof body?.enabled === "boolean") m.enabled[entry.id] = body.enabled;
      return json({ ok: true, platform: entry.id, needs_restart: true });
    }
    const test = /^\/messaging\/([a-z_]+)\/test$/.exec(path);
    if (test && method === "POST") { const r = rows().find((x) => x.id === test[1])!; return json({ ok: r.state === "connected", state: r.state, message: `Zustand: ${r.state}` }); }
    if (path === "/gateway" && method === "GET") return json({ running: m.gateway.running, state: m.gateway.running ? "running" : null, busy: m.gateway.busy, active_sessions: m.gateway.sessions, version: "0.22.5" });
    const gw = /^\/gateway\/(start|stop|restart)$/.exec(path);
    if (gw && method === "POST") {
      if (dash.stepUp) return json(stepUpBody, 401);
      if (gw[1] !== "start" && (m.gateway.busy || m.gateway.sessions) && !body?.confirm_interrupt) {
        return json({ detail: { code: "interrupt_confirmation_required", message: `Das Gateway ist beschäftigt (${m.gateway.sessions} laufende Sitzung(en)). Der Neustart unterbricht sie.`, active_sessions: m.gateway.sessions, busy: m.gateway.busy } }, 409);
      }
      m.gateway.running = gw[1] !== "stop"; m.gateway.busy = false; m.gateway.sessions = 0;
      return json({ ok: true, started: true, action: `gateway-${gw[1]}`, interrupted: Boolean(body?.confirm_interrupt) });
    }
    if (/^\/gateway\/actions\/gateway-(start|stop|restart)$/.test(path)) return json({ name: path.split("/").pop(), running: false, exit_code: 0, lines: ["Gateway gestartet"] });
    if (path === "/messaging/telegram/onboarding" && method === "POST") {
      if (dash.stepUp) return json(stepUpBody, 401);
      m.polls = 0;
      return json({ pairing_id: "pair_abc123", suggested_username: "hermes_test_bot", deep_link: "https://t.me/newbot/hermes/hermes_test_bot", expires_at: "2026-10-24T18:00:00Z" });
    }
    const tg = /^\/messaging\/telegram\/onboarding\/(pair_[a-z0-9]+)(\/apply)?$/.exec(path);
    if (tg && method === "GET") { m.polls += 1; return json(m.polls < 2 ? { status: "waiting", expires_at: "2026-10-24T18:00:00Z" } : { status: "ready", bot_username: "hermes_test_bot", owner_user_id: "424242", expires_at: "2026-10-24T18:00:00Z" }); }
    if (tg && tg[2] && method === "POST") {
      if (dash.stepUp) return json(stepUpBody, 401);
      const ids = (body?.allowed_user_ids ?? []) as string[];
      m.env.TELEGRAM_BOT_TOKEN = "123456:SECRET-FROM-TELEGRAM"; m.env.TELEGRAM_ALLOWED_USERS = ids.join(","); m.enabled.telegram = true; m.applied = ids;
      return json({ ok: true, platform: "telegram", bot_username: "hermes_test_bot", needs_restart: true, restart_started: false, restart_error: "Live sessions" });
    }
    if (tg && method === "DELETE") return json({ ok: true });
  }
  const lcPath = /^\/hermes-profiles(\/import|\/active|\/([^/]+))?$/.exec(path);
  if (lcPath) {
    if (!dash.available) return json({ detail: "Für diesen Host ist kein Dashboard eingerichtet" }, 501);
    if (method !== "GET" && dash.stepUp) return json(stepUpBody, 401);
    if (path === "/hermes-profiles" && method === "GET") {
      return json({ profiles: dash.lcProfiles.map((n: string) => ({ name: n, is_default: n === dash.lcProfiles[0], has_env: true })), active: dash.lcActive });
    }
    if (path === "/hermes-profiles" && method === "POST") {
      if (body?.clone_from && !dash.lcProfiles.includes(String(body.clone_from))) return json({ detail: "Quelle: unbekanntes Profil" }, 422);
      dash.lcProfiles.push(String(body?.name));
      return json({ ok: true, name: String(body?.name), setup: "Einrichtung: hermes setup" });
    }
    if (path === "/hermes-profiles/import" && method === "POST") {
      if (!(init?.body instanceof FormData)) return json({ detail: "Nur hochgeladene Archive, kein Serverpfad" }, 422);
      if (!dash.lcProfiles.includes("rueck")) dash.lcProfiles.push("rueck");
      return json({ ok: true, name: "rueck" });
    }
    if (path === "/hermes-profiles/active" && method === "POST") { dash.lcActive = String(body?.name); return json({ ok: true }); }
    const one = /^\/hermes-profiles\/([^/]+)$/.exec(path);
    if (one && method === "PATCH") {
      dash.lcProfiles = dash.lcProfiles.map((n: string) => (n === one[1] ? String(body?.new_name) : n));
      if (dash.lcActive === one[1]) dash.lcActive = String(body?.new_name);
      return json({ ok: true, name: String(body?.new_name) });
    }
    if (one && method === "DELETE") {
      if (String(body?.confirm) !== one[1]) return json({ detail: "Nur mit Namenseingabe" }, 422);
      dash.lcProfiles = dash.lcProfiles.filter((n: string) => n !== one[1]);
      return json({ ok: true });
    }
  }
  if (path.startsWith("/hermes-models")) {
    if (!dash.available) return json({ detail: "Für diesen Host ist kein Dashboard eingerichtet" }, 501);
    if (method !== "GET" && dash.stepUp) return json(stepUpBody, 401);
    if (dash.mdDown && method === "GET") return json({ detail: "Das Dashboard liefert Modell-Info in unbekannter Form" }, 502);
    if (path === "/hermes-models/info" && method === "GET") return json(dash.mdFresh ? { provider: "", model: "", configured: false, context_window: 0, capabilities: {} } : { provider: "anthropic", model: "claude-test", configured: true, context_window: 200000, capabilities: { supports_tools: true } });
    if (path === "/hermes-models/options" && method === "GET" && dash.mdFresh) return json({ providers: [], current: { provider: "", model: "" } });
    if (path === "/hermes-models/options" && method === "GET") return json({ providers: [{ slug: "anthropic", name: "Anthropic", models: ["claude-test", "claude-small"], authenticated: true }], current: { provider: "anthropic", model: "claude-test" } });
    if (path === "/hermes-models/recommended-default" && method === "GET") return json({ provider: "anthropic", model: "claude-test" });
    if (path === "/hermes-models/auxiliary" && method === "GET") return json({ main: { provider: "anthropic", model: "claude-test" }, tasks: [{ task: "coding", provider: "auto", model: "" }] });
    if (path === "/hermes-models/moa" && method === "GET") return json({ presets: { d: { reference_models: [{ provider: "anthropic", model: "claude-test" }], aggregator: { provider: "anthropic", model: "claude-test" } } }, active_preset: "d", default_preset: "d" });
    if (path === "/hermes-models/set" && method === "POST") {
      if (String(body?.scope) !== "main" && String(body?.scope) !== "auxiliary") return json({ detail: [{ loc: ["body", "scope"], msg: "muss main oder auxiliary sein" }] }, 422);
      if (!String(body?.model ?? "").trim()) return json({ detail: [{ loc: ["body", "model"], msg: "leer ist kein Modell" }] }, 422);
      if (/opus|o1|o3|gpt-5|claude-teuer/i.test(String(body?.model ?? "")) && !body?.confirm_expensive_model) return json({ ok: false, confirm_required: true, confirm_message: "Teures Modell: bitte bestätigen." });
      dash.mdFresh = false; return json({ ok: true, provider: String(body?.provider), model: String(body?.model).trim() });
    }
    return json({ detail: "Unbekannte Modell-Route" }, 404);
  }
  if (/^\/hermes-(credentials|voice|system|curator|learning|appearance|privacy)/.test(path)) {
    if (!dash.available) return json({ detail: "Für diesen Host ist kein Dashboard eingerichtet" }, 501);
    const x = dash.p3;
    if (method !== "GET" && dash.stepUp) return json(stepUpBody, 401);
    const qs = new URL(rest, "http://bff").searchParams;
    if (path === "/hermes-credentials" && method === "GET") return json({ providers: x.pool });
    if (path === "/hermes-credentials" && method === "POST") {
      const row = x.pool.find((p) => p.provider === body?.provider) ?? (x.pool.push({ provider: String(body?.provider), entries: [] }), x.pool[x.pool.length - 1]);
      row.entries.push({ index: row.entries.length + 1, label: String(body?.label ?? ""), source: "manual", token_tail: String(body?.api_key).slice(-4) }); return json({ ok: true, count: row.entries.length });
    }
    const rm = /^\/hermes-credentials\/([^/]+)\/(\d+)$/.exec(path);
    if (rm && method === "DELETE") {
      if (qs.get("confirm") !== rm[1]) return json({ detail: "Entfernen: den Anbieternamen zur Bestätigung eingeben" }, 422);
      const row = x.pool.find((p) => p.provider === rm[1]); if (row) row.entries = row.entries.filter((e) => e.index !== Number(rm[2])); return json({ ok: true, count: row?.entries.length ?? 0 });
    }
    if (path === "/hermes-voice/status") return json(x.voiceOn ? { mode: "chained", available: true, reason: "" } : { mode: "", available: false, reason: "Kein Sprachanbieter eingerichtet" });
    if (path === "/hermes-voice/speak" && method === "POST") return json({ data_url: "data:audio/mpeg;base64,AAAA", mime_type: "audio/mpeg", provider: "edge" });
    if (path === "/hermes-voice/transcribe" && method === "POST") return json({ transcript: "Hallo Welt", provider: "whisper" });
    if (path === "/hermes-system") return json({ hermes_version: "0.22.5", system: "Linux", arch: "x86_64", python_version: "3.14", cpu_count: 8, cpu_percent: 5, memory: { used: 4 * 1024 ** 3, total: 16 * 1024 ** 3 }, disk: { used: 100 * 1024 ** 3, total: 500 * 1024 ** 3 } });
    if (path === "/hermes-curator" && method === "GET") return json({ enabled: true, paused: x.paused, interval_hours: 168, last_run_at: null, min_idle_hours: 2, stale_after_days: 30, archive_after_days: 90 });
    if (path === "/hermes-curator/paused") { x.paused = Boolean(body?.paused); return json({ ok: true, paused: x.paused }); }
    if (path === "/hermes-curator/run" && method === "POST") return body?.confirm_archive ? json({ started: true, name: "curator-run" }) : json({ detail: "confirm_archive=true senden" }, 422);
    if (path === "/hermes-curator/run") return json({ running: false, exit_code: 0, log: "Curator fertig" });
    if (path === "/hermes-learning") return json({ nodes: Object.keys(x.nodes).map((id) => ({ id, label: id, kind: id.startsWith("mem:") ? "memory" : "skill", category: "", use_count: 2, state: "", pinned: false })), edges: Object.keys(x.nodes).length > 1 ? [{ source: "skill-a", target: "mem:1" }] : [] });
    if (path === "/hermes-learning/node") {
      const id = qs.get("id") ?? "";
      if (method === "GET") return id in x.nodes ? json({ id, kind: "skill", label: id, content: x.nodes[id] }) : json({ detail: "Diesen Knoten gibt es nicht" }, 404);
      if (method === "DELETE") { if (qs.get("confirm") !== id) return json({ detail: "Löschen: die Knoten-ID zur Bestätigung eingeben" }, 422); delete x.nodes[id]; return json({ ok: true }); }
      if (method === "PUT") { x.nodes[String(body?.id)] = String(body?.content); return json({ ok: true }); }
    }
    if (path === "/hermes-appearance" && method === "GET") return json({ themes: [{ name: "default", label: "Default", description: "" }, { name: "midnight", label: "Midnight", description: "" }], active: x.theme, font: x.font, fonts: ["theme", "inter"] });
    if (path === "/hermes-appearance/theme") { x.theme = String(body?.name); return json({ ok: true }); }
    if (path === "/hermes-appearance/font") { x.font = String(body?.font); return json({ ok: true }); }
    if (path === "/hermes-privacy" && method === "GET") return json({ egress: "Egress-Proxy: aus", metrics: x.metrics });
    if (path === "/hermes-privacy/metrics") {
      if (body?.send && !body?.confirm_send) return json({ detail: "confirm_send=true senden" }, 422);
      x.metrics = { ...x.metrics, enabled: Boolean(body?.enabled), send: Boolean(body?.send), decided: true }; return json({ ok: true, metrics: x.metrics });
    }
  }
  if (path.startsWith("/hermes-pairing") || path.startsWith("/hermes-webhooks")) {
    if (!dash.available) return json({ detail: "Für diesen Host ist kein Dashboard eingerichtet" }, 501);
    const ac = dash.ac;
    if (method !== "GET" && dash.stepUp) return json(stepUpBody, 401);
    const pairing = () => ({ pending: ac.pending.map((p) => ({ ...p, age_minutes: 3 })), approved: ac.approved });
    const hooks = () => ({ enabled: ac.hooksOn, base_url: "http://gw.test", subscriptions: ac.hooks.map((h) => ({ name: h.name, description: "", events: ["push"], deliver: "log", url: `http://gw.test/webhooks/${h.name}`, secret_set: true, enabled: h.enabled })) });
    if (path === "/hermes-pairing" && method === "GET") return json(pairing());
    if (path === "/hermes-pairing/approve" && method === "POST") {
      const p = ac.pending.find((x) => x.request_id === body?.request_id); if (!p) return json({ detail: "nicht gefunden" }, 404);
      ac.pending = ac.pending.filter((x) => x !== p); ac.approved.push({ platform: p.platform, user_id: p.user_id, user_name: p.user_name }); return json(pairing());
    }
    if (path === "/hermes-pairing/revoke" && method === "POST") {
      if (body?.confirm !== body?.user_id) return json({ detail: "Sperren: die Nutzer-ID zur Bestätigung eingeben" }, 422);
      ac.approved = ac.approved.filter((x) => x.user_id !== body?.user_id); return json(pairing());
    }
    if (path === "/hermes-webhooks" && method === "GET") return json(hooks());
    if (path === "/hermes-webhooks/enable" && method === "POST") { if (body?.confirm_restart !== true) return json({ detail: "confirm_restart" }, 422); ac.hooksOn = true; return json({ ok: true, ...hooks() }); }
    if (path === "/hermes-webhooks" && method === "POST") {
      if (!ac.hooksOn) return json({ detail: "Die Webhook-Plattform ist ausgeschaltet" }, 409);
      ac.hooks.push({ name: String(body?.name), enabled: true }); return json({ ok: true, name: String(body?.name), url: `http://gw.test/webhooks/${String(body?.name)}`, secret: "whsec-EINMALIG-123" });
    }
    const tog = /^\/hermes-webhooks\/([^/]+)\/enabled$/.exec(path);
    if (tog && method === "PUT") { const h = ac.hooks.find((x) => x.name === tog[1]); if (h) h.enabled = Boolean(body?.enabled); return json({ ok: true }); }
    const del = /^\/hermes-webhooks\/([^/?]+)$/.exec(path);
    if (del && method === "DELETE") {
      if (new URL(rest, "http://bff").searchParams.get("confirm") !== del[1]) return json({ detail: "Löschen: den Webhook-Namen zur Bestätigung eingeben" }, 422);
      ac.hooks = ac.hooks.filter((x) => x.name !== del[1]); return json({ ok: true });
    }
    return json({ detail: "Unbekannte Zugangs-Route" }, 404);
  }
  if (path.startsWith("/hermes-sessions")) {
    if (!dash.available) return json({ detail: "Für diesen Host ist kein Dashboard eingerichtet" }, 501);
    const sa = dash.sa;
    if (sa.down) return json({ detail: "Session store is not initialized. Start this profile's gateway to initialize it." }, 503);
    if (method !== "GET" && dash.stepUp) return json(stepUpBody, 401);
    const hit = (days: number) => sa.sessions.filter((s) => s.ageDays > days && !s.active);
    const empties = () => sa.sessions.filter((s) => s.messages === 0 && !s.active);
    if (path === "/hermes-sessions/stats" && method === "GET") return json({ total: sa.sessions.length, active_store: sa.sessions.length, archived: 0, messages: sa.sessions.reduce((n, s) => n + s.messages, 0), by_source: { cli: sa.sessions.length } });
    if (path === "/hermes-sessions/prune/preview" && method === "POST") { const h = hit(Number(body?.older_than_days)); return json({ matched: h.length, skipped_open: 1, sample: h.map((s) => ({ id: s.id, title: `Sitzung ${s.id}` })) }); }
    if (path === "/hermes-sessions/prune" && method === "POST") {
      const h = hit(Number(body?.older_than_days));
      if (Number(body?.confirm_count) !== h.length) return json({ detail: `Aufräumen: die Vorschau zeigt ${h.length} Sitzungen, die eingegebene Zahl stimmt nicht` }, 422);
      sa.sessions = sa.sessions.filter((s) => !h.includes(s)); return json({ ok: true, removed: h.length, skipped_open: 1 });
    }
    if (path === "/hermes-sessions/empty" && method === "GET") return json({ count: empties().length });
    if (path === "/hermes-sessions/empty" && method === "DELETE") {
      const e = empties();
      if (new URL(rest, "http://bff").searchParams.get("confirm") !== String(e.length)) return json({ detail: "Löschen: die eingegebene Zahl stimmt nicht" }, 422);
      sa.sessions = sa.sessions.filter((s) => !e.includes(s)); return json({ ok: true, deleted: e.length });
    }
    return json({ detail: "Unbekannte Sitzungs-Route" }, 404);
  }
  if (path.startsWith("/hermes-delegation") || path.startsWith("/hermes-endpoints") || path.startsWith("/hermes-local-models")) {
    if (!dash.available) return json({ detail: "Für diesen Host ist kein Dashboard eingerichtet" }, 501);
    const ep = dash.ep;
    if (method !== "GET" && dash.stepUp) return json(stepUpBody, 401);
    const rows = () => ep.endpoints.map((e) => ({ ...e, models: [e.model], has_api_key: e.hasKey, api_key_preview: e.hasKey ? "sk-…9876" : "", is_current: ep.current === e.id }));
    if (path === "/hermes-delegation" && method === "GET") return json({ configured: ep.backend, blocked_reason: null, backends: [{ name: "default", description: "Eingebaut", builtin: true }, { name: "docker", description: "Container", builtin: false }], profiles: ["gamma"] });
    if (path === "/hermes-delegation/backend" && method === "PUT") { ep.backend = String(body?.backend); return json({ ok: true, backend: ep.backend }); }
    if (path === "/hermes-endpoints" && method === "GET") return json({ endpoints: rows(), current: {} });
    if (path === "/hermes-endpoints" && method === "POST") {
      if (!/^https?:\/\/[^@]+$/.test(String(body?.base_url))) return json({ detail: [{ loc: ["body", "base_url"], msg: "URL: nur http(s) ohne Zugangsdaten" }] }, 422);
      const id = String(body?.name).toLowerCase().replace(/ /g, "-");
      ep.endpoints.push({ id, name: String(body?.name), base_url: String(body?.base_url), model: String(body?.model), hasKey: Boolean(body?.api_key) });
      return json({ ok: true, id, endpoints: rows(), current: {} });
    }
    if (path === "/hermes-endpoints/validate" && method === "POST") return json({ ok: true, reachable: true, message: "ok", models: ["llama3"] });
    const act = path.match(/^\/hermes-endpoints\/([^/]+)\/activate$/);
    if (act && method === "POST") { ep.current = act[1]; return json({ ok: true, id: act[1] }); }
    const one = path.match(/^\/hermes-endpoints\/([^/?]+)$/);
    if (one && method === "DELETE") {
      if (new URL(rest, "http://bff").searchParams.get("confirm") !== one[1]) return json({ detail: "Löschen: die Endpunkt-ID zur Bestätigung eingeben" }, 422);
      ep.endpoints = ep.endpoints.filter((e) => e.id !== one[1]); return json({ ok: true });
    }
    if (path === "/hermes-local-models/status" && method === "GET") return json({ enabled: false, runtime_installed: false, server_running: false, models: [{ id: "g1", name: "llama3.gguf", size_bytes: 1048576 }] });
    return json({ detail: "Unbekannte Endpunkt-Route" }, 404);
  }
  if (path === "/hermes-ops/backup" && method === "POST") {
    if (dash.stepUp) return json(stepUpBody, 401);
    if (String(body?.confirm) !== "gamma") return json({ detail: "Nur mit Namenseingabe" }, 422);
    return json({ ok: true, archive: "/hermes/backup-2026.tgz" });
  }
  if (path === "/hermes-ops/doctor" && method === "POST") {
    if (dash.stepUp) return json(stepUpBody, 401);
    return json({ ok: true, name: "doctor" });
  }
  if (path === "/hermes-ops/actions/doctor" && method === "GET") return json({ name: "doctor", lines: ["alles bereit"] });
  if (path.startsWith("/hermes-memory")) {
    if (!dash.hm.available) return json({ detail: "Für diesen Host ist kein Dashboard eingerichtet" }, 501);
    const h = dash.hm;
    if (method !== "GET" && dash.stepUp) return json(stepUpBody, 401);
    const status = (n: string) => (n === "byterover" ? "unavailable" : h.keySet ? "ready" : "needs_config");
    if (path === "/hermes-memory" && method === "GET") {
      return json({ active: h.active, files: h.files, providers: [
        { name: "byterover", description: "ByteRover, Wissensbaum.", status: "unavailable", configured: false, available: false, required_env: [], missing: [{ name: "brv", install: "curl -fsSL https://byterover.dev/install.sh | sh" }] },
        { name: "retaindb", description: "RetainDB, Cloud-Gedächtnis.", status: status("retaindb"), configured: h.keySet, available: true, required_env: ["RETAINDB_API_KEY"], missing: [] }] });
    }
    if (path === "/hermes-memory/provider" && method === "PUT") { h.active = String(body?.provider); return json({ ok: true, active: h.active }); }
    if (path === "/hermes-memory/reset" && method === "POST") {
      const t = String(body?.target); if (t === "all" || t === "memory") h.files.memory = 0; if (t === "all" || t === "user") h.files.user = 0;
      return json({ ok: true, deleted: t === "memory" ? ["MEMORY.md"] : t === "user" ? ["USER.md"] : ["MEMORY.md", "USER.md"] });
    }
    const prov = /^\/hermes-memory\/providers\/(byterover|retaindb)$/.exec(path);
    if (prov && method === "GET") {
      return json({ name: prov[1], fields: prov[1] === "retaindb" ? [
        { key: "api_key", label: "Api Key", kind: "secret", description: "RetainDB API key", required: true, is_set: h.keySet, options: [], url: "https://retaindb.com" },
        { key: "project", label: "Project", kind: "text", description: "Projekt", is_set: Boolean(h.project), options: [], value: h.project },
        { key: "mode", label: "Mode", kind: "select", description: "Modus", is_set: true, options: [{ value: "fast" }, { value: "deep" }], value: h.mode }] : [
        { key: "auto_extract", label: "Auto Extract", kind: "select", description: "Automatisch", is_set: true, options: [{ value: "true" }, { value: "false" }], value: "true" }] });
    }
    if (prov && method === "PUT") {
      if (prov[1] === "byterover") return json({ detail: "Das Dashboard meldet Fehler 400: Memory provider 'byterover' is not ready (unavailable)." }, 502);
      const v = (body?.values ?? {}) as Record<string, string>;
      if (v.api_key) h.keySet = true; if ("project" in v) h.project = v.project; if ("mode" in v) h.mode = v.mode;
      h.active = "retaindb";
      return json({ ok: true, active: "retaindb" });
    }
  }
  const toolRows = () => TOOL_CATALOG.map((t) => ({ name: t.name, label: t.label, description: t.description, enabled: dash.tools.enabled[t.name], configured: !t.providers.length || t.providers.some((p) => (p.env as Array<{ key: string }>).every((v) => v.key in dash.tools.keys)), tools: t.tools }));
  const toolPath = /^\/tools(?:\/([a-z_]+)(?:\/(provider|env|model|models))?)?$/.exec(path);
  if (path === "/terminal-backends" && method === "GET") {
    return dash.tools.available ? json({ active: "local", backends: [{ name: "local", label: "Local", description: "Run commands directly on this machine. No isolation.", active: true, status: "ready", detail: "" }, { name: "docker", label: "Docker / Podman", description: "Isolated container.", active: false, status: "needs_setup", detail: "Docker CLI not found" }] }) : json({ detail: "Für diesen Host ist kein Dashboard eingerichtet" }, 501);
  }
  if (toolPath) {
    if (!dash.tools.available) return json({ detail: "Für diesen Host ist kein Dashboard eingerichtet" }, 501);
    const [, name, sub] = toolPath;
    const entry = TOOL_CATALOG.find((t) => t.name === name);
    if (!name) return json({ toolsets: toolRows() });
    if (!entry) return json({ detail: "Unbekannte Werkzeuggruppe" }, 404);
    if (method !== "GET" && dash.stepUp) return json(stepUpBody, 401);
    if (!sub && method === "GET") {
      return json({ name, has_category: entry.providers.length > 0, active_provider: dash.tools.provider[name] ?? null, providers: entry.providers.map((p) => ({
        name: p.name, badge: p.badge, status: p.post_setup && dash.tools.installed ? "ready" : p.status, post_setup: p.post_setup ?? null, is_active: dash.tools.provider[name] === p.name, capabilities: p.capabilities,
        env_vars: (p.env as Array<{ key: string; prompt: string; url?: string }>).map((v) => ({ ...v, is_set: v.key in dash.tools.keys })) })) });
    }
    if (!sub && method === "PUT") {
      const wantsInstall = entry.providers.some((p) => p.post_setup && !dash.tools.installed);
      if (body?.enabled && wantsInstall && !body?.accept_install) return json({ detail: { code: "install_consent_required", message: "Das Einschalten kann Software installieren (cua_driver). Bitte ausdrücklich zustimmen." } }, 409);
      dash.tools.enabled[name] = Boolean(body?.enabled);
      return json({ ok: true, name, enabled: body?.enabled, post_setup_started: body?.enabled && wantsInstall ? "cua_driver" : null });
    }
    if (sub === "provider" && method === "PUT") { dash.tools.provider[name] = String(body?.provider); return json({ ok: true, name, provider: body?.provider, capability: body?.capability ?? null }); }
    if (sub === "env" && method === "PUT") {
      const env = (body?.env ?? {}) as Record<string, string>;
      if (Object.values(env).some((v) => v.includes("abgelehnt"))) return json({ detail: "BRAVE_SEARCH_API_KEY: das ist eine geschwärzte Vorschau, kein Schlüssel" }, 422);
      Object.assign(dash.tools.keys, env);
      return json({ ok: true, name, saved: Object.keys(env), skipped: [] });
    }
    if (sub === "models" && method === "GET") {
      return json(name === "image_gen" ? { name, has_models: true, provider: "FAL.ai", models: [{ id: "flux-2-pro", display: "FLUX 2 Pro", price: "$0.05" }, { id: "flux-2-klein", display: "FLUX 2 Klein", price: "$0.01" }], current: dash.tools.model, default: "flux-2-pro" } : { name, has_models: false, models: [], current: null, default: null });
    }
    if (sub === "model" && method === "PUT") { dash.tools.model = String(body?.model); return json({ ok: true, name, model: dash.tools.model }); }
  }
  return undefined;
}

export function installBackend(agents: string[] = ["gamma"], features = ["runs", "steer"], uiOverride: Partial<UiConfig> = {}, memoryCapabilities = ["stats", "items", "search", "graph", "entities", "models", "reflect"], knowledgeProviders: KnowledgeProvider[] = []) {
  invalidate("knowledge");
  const kn: KnowledgeState = { available: true, truncated: false, stepUp: false, statsError: null, searchError: null, docs: knowledgeDocs() };
  FakeEventSource.all = [];
  try { sessionStorage.clear(); } catch { /* ohne Speicher */ }
  try { localStorage.clear(); } catch { /* ohne Speicher */ }
  // Wie das BFF: Speichern ändert die Config, die Antwort ist die ganze Config.
  const uiState: UiConfig = { ...baseUi(), ...uiOverride };
  const calls: Call[] = [];
  const rooms: Room[] = [];
  const quota: { mode: QuotaMode } = { mode: "ok" };
  const dash: DashState = {
    available: true, reason: null, soul: "Du bist Gamma.\nDu antwortest knapp.\n", description: "", model: { provider: "mock", model: "mock-large" },
    history: [], versions: {}, stepUp: false, keys: { ANTHROPIC_API_KEY: "sk-ant-geheim-1234" },
    loggedIn: new Set(["openai-codex"]), polls: 0, loginError: null,
    config: { model: "claude-test", "agent.service_tier": "normal", "agent.max_turns": 90, "display.streaming": true, fallback_providers: [], "web.api_key": null },
    msg: { available: true, enabled: {}, env: {}, gateway: { running: false, busy: false, sessions: 0 }, polls: 0, applied: [] },
    hm: { available: true, active: "", files: { memory: 120, user: 45 }, keySet: false, project: "", mode: "fast" },
    tools: { available: true, enabled: { terminal: true, web: false, image_gen: true, computer_use: false }, keys: {}, provider: {}, model: "flux-2-pro", installed: false },
    ac: { pending: [{ platform: "telegram", request_id: "req-1", user_id: "42", user_name: "Anna" }], approved: [{ platform: "telegram", user_id: "7", user_name: "Bob" }], hooksOn: false, hooks: [] },
    mdFresh: false,
    sa: { sessions: [{ id: "a1", ageDays: 200, messages: 3 }, { id: "a2", ageDays: 100, messages: 2 }, { id: "a3", ageDays: 1, messages: 4 }, { id: "e1", ageDays: 5, messages: 0 }, { id: "act", ageDays: 300, messages: 1, active: true }] },
    ep: { backend: "default", endpoints: [], current: "" },
    lcProfiles: [...agents], lcActive: agents[0] ?? "gamma",
    p3: { pool: [{ provider: "openrouter", entries: [{ index: 1, label: "privat", source: "manual", token_tail: "abcd" }, { index: 2, label: "aus .env", source: "env:OPENROUTER_API_KEY", token_tail: "wxyz" }] }], voiceOn: true, paused: false,
      nodes: { "skill-a": "# Skill A", "mem:1": "Merke dir das" }, theme: "default", font: "theme", metrics: { enabled: false, send: false, decided: false, managed: false }, unlocked: true, workers: [{ run_id: 7, task_id: "t_1" }] },
  };
  let runs = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body instanceof FormData ? { archive: "[datei]" } : init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/bff/me") return json({ user: { id: "42", name: "alex" }, auth_mode: "none", fresh: true, build: "3f5c30c" });
    if (url === "/bff/hosts") return json({ hosts: hostsFor(agents), config_error: null });
    if (url === "/bff/ui") return json(uiState);
    if (url.startsWith("/bff/rooms")) {
      const u = new URL(url, "http://bff");
      const m = /^\/bff\/rooms(?:\/([0-9a-f]{12}))?(?:\/(messages|stop|events))?$/.exec(u.pathname);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (m && !m[1]) {
        if (method === "POST") {
          const room = roomOf("abcabcabcabc", body.name, (body.members as Array<{ agent: string }>).map((x) => x.agent), { messages: [] });
          rooms.push(room);
          return json(room, 201);
        }
        const archived = u.searchParams.get("archived") === "true";
        return json({ rooms: rooms.filter((r) => r.archived === archived) });
      }
      const room = m && rooms.find((r) => r.id === m[1]);
      if (room && !m![2]) {
        if (method === "PATCH") { Object.assign(room, body); return json(room); }
        return json(room);
      }
      if (room && m![2] === "messages" && method === "POST") return json({ message: { seq: (room.messages?.length ?? 0) + 1, author: "user", kind: "message", text: body.text, mentions: [], at: 1_792_000_100 } }, 202);
      if (room && m![2] === "stop" && method === "POST") return json({ stopped: true });
      return json({ detail: "nicht da" }, 404);
    }
    if (url.startsWith("/bff/knowledge")) {
      const r = knowledgeRoute(url, method, kn, knowledgeProviders, json, init?.body ? JSON.parse(String(init.body)) : undefined);
      if (r) return r;
    }
    if (url.startsWith("/bff/memory")) {
      const r = memoryRoute(url, method, memoryCapabilities, json, init?.body ? JSON.parse(String(init.body)) : undefined);
      if (r) return r;
    }
    const put = method === "PUT" ? init?.body && JSON.parse(String(init.body)) : undefined;
    if (method === "PUT" && url.startsWith("/bff/ui/")) {
      if (!uiState.writable) return json({ detail: uiState.write_error }, 409);
      if (url === "/bff/ui/shader") { uiState.ui = { backgroundShader: put }; return json(uiState); }
      const key = decodeURIComponent(url.slice("/bff/ui/profiles/".length));
      const body = put as ProfileInput;
      delete uiState.sigils[key]; delete uiState.labels[key];
      if (body.label) uiState.labels[key] = body.label;
      if (body.sigil) {
        const { svg, ...rest } = body.sigil;
        const sg: SigilConfig = { ...rest };
        if (rest.type === "svg") sg.src = `/bff/ui/sigils/${key.replace(/[^a-z0-9]+/g, "-")}.svg`;
        if (rest.type === "glyph" && !rest.glyph?.startsWith("neutral/")) sg.src = `/bff/ui/glyphs/${rest.glyph}.svg`;
        void svg;
        uiState.sigils[key] = sg;
      }
      return json(uiState);
    }
    if (url === "/bff/security") return json({ step_up: { enabled: true, window_s: 600, proof: "auth_time" } });
    if (url.endsWith("/_cli-auth") || url.endsWith("/_cli-auth/refresh")) {
      const refreshed = url.endsWith("/refresh");
      if (url.startsWith("/bff/h/laptop/")) return json({ available: false, reason: "Host-Dienst nicht eingerichtet" });
      return json({ available: true, reason: null, clis: [
        { id: "codex", state: "signed_in", method: "ChatGPT", checked_at: "2026-01-01T00:00:00+00:00", reason: null },
        { id: "claude", state: refreshed ? "signed_in" : "signed_out", method: refreshed ? "claude.ai" : null, checked_at: "2026-01-01T00:00:00+00:00", reason: null },
        { id: "opencode", state: "unknown", method: null, checked_at: "2026-01-01T00:00:00+00:00", reason: "Zeitueberschreitung (15 s)" },
        { id: "agy", state: refreshed ? "signed_in" : "unknown", method: refreshed ? "OAuth" : null, checked_at: refreshed ? "2026-01-01T00:00:00+00:00" : null, reason: refreshed ? null : "Noch nicht geprüft" }] });
    }
    const qm = quota.mode;
    if (url === "/bff/quota/summary") return json(quotaSummary(agents, qm));
    if (/^\/bff\/h\/server\/hermes\/_quota(\?refresh=1)?$/.test(url)) return json({ profiles: Object.fromEntries(agents.map((a) => [a, quotaOf(a, qm)])) });
    if (url === "/bff/h/server/hermes/_provider-matrix") return json(providerMatrix(agents, dash));
    if (url === "/bff/h/laptop/hermes/_provider-matrix") return json({ detail: "Hermes nicht erreichbar: keine Verbindung zu 100.64.3.4:8642. Läuft der API-Server dort und lauscht auf dieser Adresse?" }, 502);
    const hs = /^\/bff\/h\/server\/(_achievements|_kanban)(\/[^?]*)?(\?.*)?$/.exec(url);
    if (hs) {
      const x = dash.p3; const sub = hs[2] ?? "";
      const bd = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      if (method !== "GET" && dash.stepUp && !(sub === "/dispatch" && bd?.dry_run)) return json(stepUpBody, 401);
      const ach = () => ({ total: 3, unlocked: x.unlocked ? 1 : 0, discovered: 1, secret: 1, generated_at: 1_790_000_000, is_stale: Boolean(x.stale), items: [
        { id: "a", name: "Let Him Cook", description: "Viele Werkzeugaufrufe", category: "x", icon: "", state: x.unlocked ? "unlocked" : "discovered", unlocked: x.unlocked, tier: x.unlocked ? "Bronze" : null, progress: 5, next_threshold: 10, progress_pct: 50, unlocked_at: null },
        { id: "s", name: "???", description: "Geheim, bis Hermes das erste passende Verhalten sieht.", category: "", icon: "", state: "secret", unlocked: false, tier: null, progress: 0, next_threshold: null, progress_pct: 0, unlocked_at: null }] });
      if (hs[1] === "_achievements") {
        if (sub === "") return json(ach());
        if (sub === "/rescan") return json(ach());
        if (sub === "/reset") { if (bd?.confirm !== "reset") return json({ detail: "reset eintippen" }, 422); x.unlocked = false; return json({ ok: true }); }
      } else {
        if (sub === "/diagnostics") return json({ count: 1, items: [{ task_id: "t_1", title: "Hängt", status: "blocked", assignee: "gamma", diagnostics: [{ kind: "stuck", severity: "warning", title: "Aufgabe blockiert", detail: "" }] }] });
        if (sub === "/workers") return json({ count: x.workers.length, workers: x.workers.map((w) => ({ ...w, title: "Lauf", profile: "gamma", started_at: 1, last_heartbeat_at: 2, max_runtime_seconds: 600 })) });
        const t = /^\/runs\/(\d+)\/terminate$/.exec(sub);
        if (t) { if (bd?.confirm !== t[1]) return json({ detail: "Nummer eintippen" }, 422); x.workers = x.workers.filter((w) => w.run_id !== Number(t[1])); return json({ ok: true, run_id: Number(t[1]) }); }
        if (/\/estimate$/.test(sub)) return json({ ok: true, est_tokens: 1200, complexity: "M", rationale: "Mittel", reason: "", model: "m" });
        if (/\/specify$/.test(sub)) return bd?.confirm ? json({ ok: true, reason: "", new_title: "Klarer Titel" }) : json({ detail: "confirm" }, 422);
        if (sub === "/dispatch") return json({ dry_run: Boolean(bd?.dry_run), spawned: x.spawnNone ? [] : ["t_1"], promoted: [] });
      }
    }
    const m = /^\/bff\/h\/server\/hermes\/([^/]+)(\/.*)$/.exec(url);
    if (m && agents.includes(m[1])) {
      const rest = m[2];
      const parsed = init?.body instanceof FormData ? { archive: "[datei]" } : init?.body ? JSON.parse(String(init.body)) : undefined;
      const d = dashboardRoute(rest, method, m[1], dash, json, parsed, init);
      if (d) return d;
      if (/^\/quota(\?refresh=1)?$/.test(rest)) return json(quotaOf(m[1], qm));
      if (rest === "/status") return json({ state: "online", online: true, version: "0.21.6", features, error: null });
      if (rest === "/models") return json({ providers: [{ slug: "mock", name: "Mock", authenticated: true, is_current: true, models: ["mock-large", "mock-small"] }], model: "mock-large", provider: "mock" });
      if (rest === "/skills") return json({ object: "list", data: [{ name: "plan", description: "Zerlegt Aufgaben in Schritte.", category: "software-development" }, { name: "himalaya", description: "E-Mail über IMAP.", category: "email" }] });
      if (rest === "/toolsets") return json({ object: "list", data: [{ name: "terminal", label: "Terminal", enabled: true, configured: true, tools: ["terminal"] }, { name: "web", label: "Web", enabled: true, configured: false }, { name: "browser", enabled: false }] });
      if (rest === "/diagnose") return json(diag(m[1]));
      if (method === "POST" && rest === "/diagnose/run") return json(diag(m[1], true));
      if (method === "POST" && /^\/sessions\/[^/]+\/fork$/.test(rest)) return json({ session_id: `fork-${m[1]}` });
      if (/^\/sessions\/[^/]+\/messages$/.test(rest)) return json({ object: "list", data: sessionMessages(rest) });
      if (rest === "/sessions") return json({ data: [{ id: `alt-${m[1]}`, title: `Alter Chat von ${m[1]}`, last_active_at: Math.floor(Date.now() / 1000) - 7260 }] });
      if (method === "POST" && rest === "/runs") { runs += 1; return json({ run_id: `run_${runs}`, session_id: `s${runs}` }); }
      if (method === "POST" && /^\/runs\/run_\d+\/(approval|steer|stop|clarify)$/.test(rest)) return json({});
    }
    return json({ detail: "nicht da" }, 404);
  }));
  const posted = (suffix: string) => calls.filter((c) => c.method === "POST" && c.url.endsWith(suffix));
  return { calls, posted, rooms, dash, quota, kn };
}
