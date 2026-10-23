import { act } from "@testing-library/react";
import { vi } from "vitest";
import type { HostInfo, ProfileInput, SigilConfig, StreamEvent, UiConfig } from "./types";

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

export function installBackend(agents: string[] = ["raiden"], features = ["runs", "steer"], uiOverride: Partial<UiConfig> = {}) {
  FakeEventSource.all = [];
  // Wie das BFF: Speichern ändert die Config, die Antwort ist die ganze Config.
  const uiState: UiConfig = { ...baseUi(), ...uiOverride };
  const calls: Call[] = [];
  let runs = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/bff/me") return json({ user: { id: "42", name: "marc" }, auth_mode: "none", fresh: true });
    if (url === "/bff/hosts") return json({ hosts: hostsFor(agents), config_error: null });
    if (url === "/bff/ui") return json(uiState);
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
      if (rest === "/status") return json({ state: "online", online: true, version: "0.21.6", features, error: null });
      if (rest === "/models") return json({ providers: [{ slug: "mock", name: "Mock", authenticated: true, is_current: true, models: ["mock-large", "mock-small"] }], model: "mock-large", provider: "mock" });
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
  return { calls, posted };
}
