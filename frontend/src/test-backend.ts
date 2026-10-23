import { act } from "@testing-library/react";
import { vi } from "vitest";
import type { HostInfo, ProfileInput, Room, RoomEvent, SigilConfig, StreamEvent, UiConfig } from "./types";

/** Gemeinsame Test-Attrappen: BFF-Antworten und EventSource für die Seiten-Tests. */

export const hostsFor = (agents: string[]): HostInfo[] => [
  { id: "hikari", label: "Hikari", kind: "local", address: null, status: "online", detail: null, runtimes: [
    { id: "hermes", label: "Hermes", status: "online", version: "0.21.6", detail: null, multiplex: true, agents: agents.map((id) => ({ id, label: id })) }] },
  { id: "laptop", label: "Laptop", kind: "remote", address: "100.100.3.4", status: "unreachable", detail: "Host-Dienst nicht verbunden", runtimes: [
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
  id, name, archived: false, needs_user: false, created_at: 1_792_000_000, running: false, speaker: null,
  members: agents.map((a) => ({ host: "hikari", runtime: "hermes", agent: a, label: a, key: `hikari/hermes/${a}` })), ...extra,
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
  agent: `hikari/hermes/${agent}`, status: withRun ? "warn" : "ok", at: 1_792_000_000,
  checks: withRun
    ? [{ id: "run.start", label: "Run starten", status: "ok", detail: "Run run_1", ms: 12 }, { id: "run.stream", label: "Ereignisstrom bis zum Abschluss", status: "warn", detail: "Antwort kam ohne Zeichenstrom", ms: 80 }]
    : [{ id: "health", label: "Erreichbar und angemeldet", status: "ok", detail: "Version 0.21.6", ms: 5 }, { id: "models", label: "Modelle und Anbieter", status: "ok", detail: "1 Anbieter, 2 Modelle", ms: 9 }],
});

const memItem = (id: string, text: string, kind: string, entities: string[] = []) => ({ id, text, kind, context: null, entities, at: 1_792_000_000_000, tags: [], document: null });
const MEM_ITEMS = [
  memItem("f1", "Marc betreibt einen Server namens Hikari.", "world", ["Marc", "Hikari"]),
  memItem("f2", "Marc hat die WebUI gebaut.", "experience", ["Marc"]),
  memItem("f3", "Hikari läuft im Tailnet.", "world", ["Hikari"]),
];

/** Gedächtnis-Routen des BFF in Hindsights Form (nach der Normalisierung durch das BFF). */
function memoryRoute(url: string, method: string, capabilities: string[], json: (b: unknown, s?: number) => Response, body?: Record<string, unknown>): Response | undefined {
  const u = new URL(url, "http://bff");
  const path = u.pathname;
  if (path === "/bff/memory") return json({ providers: [{ id: "hindsight", type: "hindsight", label: "Hindsight", bank: "hermes", capabilities }], config_error: null });
  const m = /^\/bff\/memory\/hindsight\/([a-z]+)(?:\/(.+))?$/.exec(path);
  if (!m) return undefined;
  const [, what, rest] = m;
  const q = u.searchParams.get("q") ?? "";
  if (what === "stats") return json({ counts: [{ key: "total_nodes", value: 120 }, { key: "nodes_by_fact_type.world", value: 80 }] });
  if (what === "items") {
    const kind = u.searchParams.get("kind");
    const offset = Number(u.searchParams.get("offset") ?? 0);
    const rows = MEM_ITEMS.filter((i) => (!kind || i.kind === kind) && (!q || i.text.includes(q)));
    return json({ items: rows.slice(offset, offset + 2), total: rows.length, limit: 2, offset });
  }
  if (what === "search") return json({ items: MEM_ITEMS.filter((i) => i.text.toLowerCase().includes(q.toLowerCase())) });
  if (what === "graph") {
    if (q === "leer") return json({ nodes: [], edges: [], total: 0, truncated: false });
    return json({ nodes: [{ id: "n1", label: "Marc", kind: "person" }, { id: "n2", label: "Hikari", kind: "server" }, { id: "n3", label: "Tailnet", kind: "server" }],
      edges: [{ source: "n1", target: "n2", label: "betreibt" }, { source: "n2", target: "n3", label: null }], total: 3, truncated: false });
  }
  if (what === "entities" && rest) return json({ id: rest, name: "Marc", mentions: 7, first_seen: null, last_seen: 1_792_000_000_000, observations: [MEM_ITEMS[1]] });
  if (what === "entities") return json({ items: [{ id: "e1", name: "Marc", mentions: 7, first_seen: null, last_seen: null }, { id: "e2", name: "Hikari", mentions: 4, first_seen: null, last_seen: null }], total: 2 });
  if (what === "models") return json({ items: [{ id: "m1", name: "Zuhause", content: "**Netz:** Tailscale", query: "Wie sieht das Netz aus?", updated: 1_792_000_000_000, tags: ["netz"] }] });
  if (what === "diagnose") return json({ agent: "Gedächtnis/hindsight", status: "warn", checks: [{ id: "reach", label: "Erreichbar", status: "ok", detail: "Bank hermes", ms: 7 }, { id: "shape", label: "Antwortform", status: "warn", detail: "Graph ohne Kantenbeschriftung", ms: 9 }] });
  if (what === "reflect" && method === "POST") return json({ text: `Antwort auf: ${String(body?.query)}`, based_on: [MEM_ITEMS[0]] });
  return json({ detail: "nicht da" }, 404);
}

/** Das Dashboard hinter dem BFF: SOUL mit Verlauf. Tests ändern den Zustand direkt (z. B. `dash.soul` für einen Konflikt). */
export type DashState = {
  available: boolean; reason: string | null; soul: string; description: string; model: { provider: string; model: string };
  history: Array<{ id: string; at: string; reason: string; chars: number }>; versions: Record<string, string>; stepUp: boolean;
  keys: Record<string, string>; // gesetzte Anbieter-Keys (Variable → Wert); der Wert verlässt die Attrappe nie
};
const hashOf = (text: string) => `h${text.length}:${text.slice(0, 12)}`;

const KEY_VARS: Array<[provider: string, label: string, varName: string]> = [
  ["anthropic", "Anthropic", "ANTHROPIC_API_KEY"], ["openrouter", "OpenRouter", "OPENROUTER_API_KEY"], ["gemini", "Google Gemini", "GEMINI_API_KEY"],
];

function providersOverview(dash: DashState, days: number) {
  const providers = KEY_VARS.map(([id, label, varName]) => {
    const set = varName in dash.keys;
    const usage = id === "anthropic" ? { sessions: 12, input_tokens: 1_200_000, output_tokens: 300_000, cost_usd: 4.5, last_used_at: 1_792_000_000, models: ["claude-test", "claude-test"] } : null;
    // Anthropic und Gemini bieten auch eine Anmeldung an, beide sind hier nicht angemeldet.
    const oauth = id === "openrouter" ? null : { logged_in: false, flow: "pkce", source: null, expires_at: null, cli_command: `hermes auth add ${id}`, docs_url: null };
    return { id, label, configured: set, used: !!usage, oauth, usage,
      keys: [{ var: varName, set, redacted: set ? "sk-a…1234" : null, description: "", url: "https://example.invalid/keys", secret: true, advanced: false }] };
  });
  providers.push({ id: "openai-codex", label: "OpenAI Codex", configured: true, used: false, keys: [], usage: null,
    oauth: { logged_in: true, flow: "device_code", source: "~/.codex/auth.json", expires_at: null, cli_command: "hermes auth add openai-codex", docs_url: null } } as never);
  providers.sort((a, b) => Number(b.configured) - Number(a.configured));
  return { providers, period_days: days, warnings: [] as string[] };
}

function dashboardRoute(rest: string, method: string, agent: string, dash: DashState, json: (b: unknown, s?: number) => Response, body?: Record<string, unknown>): Response | undefined {
  if (rest === "/dashboard") {
    return json(dash.available
      ? { available: true, reason: null, profile: { name: agent, ...dash.model, description: dash.description, description_auto: false, skill_count: 12, gateway_running: false, has_env: true } }
      : { available: false, reason: dash.reason, profile: null });
  }
  const path = rest.split("?")[0];
  if (path === "/providers" && method === "GET") return json(providersOverview(dash, Number(new URL(rest, "http://bff").searchParams.get("days") ?? 30)));
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
  return undefined;
}

export function installBackend(agents: string[] = ["raiden"], features = ["runs", "steer"], uiOverride: Partial<UiConfig> = {}, memoryCapabilities = ["stats", "items", "search", "graph", "entities", "models", "reflect"]) {
  FakeEventSource.all = [];
  // Wie das BFF: Speichern ändert die Config, die Antwort ist die ganze Config.
  const uiState: UiConfig = { ...baseUi(), ...uiOverride };
  const calls: Call[] = [];
  const rooms: Room[] = [];
  const dash: DashState = {
    available: true, reason: null, soul: "Du bist Raiden.\nDu antwortest knapp.\n", description: "", model: { provider: "mock", model: "mock-large" },
    history: [], versions: {}, stepUp: false, keys: { ANTHROPIC_API_KEY: "sk-ant-geheim-1234" },
  };
  let runs = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/bff/me") return json({ user: { id: "42", name: "marc" }, auth_mode: "none", fresh: true });
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
    const m = /^\/bff\/h\/hikari\/hermes\/([^/]+)(\/.*)$/.exec(url);
    if (m && agents.includes(m[1])) {
      const rest = m[2];
      const d = dashboardRoute(rest, method, m[1], dash, json, init?.body ? JSON.parse(String(init.body)) : undefined);
      if (d) return d;
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
  return { calls, posted, rooms, dash };
}
