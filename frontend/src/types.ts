/** Gemeinsames Ereignisformat des BFF (siehe backend/app/events.py). Runtime-Eigenheiten stecken in den Adaptern. */
export type StreamEvent =
  | { type: "run.started"; run_id?: string; session_id?: string }
  | { type: "message.delta"; text: string }
  | { type: "message.interim"; text: string }
  | { type: "reasoning.delta"; text: string }
  | { type: "tool.started"; id: string; name: string; preview?: unknown }
  | { type: "tool.completed"; id: string; name: string; ok: boolean; duration_ms?: number | null; output?: unknown }
  | { type: "approval.requested"; command: string; reason: string; choices: Decision[]; timeout_s: number; smart_denied?: boolean }
  | { type: "approval.responded"; choice?: Decision | null; resolved?: unknown }
  | { type: "clarify.requested"; clarify_id?: string | null; question: string; choices?: string[] | null }
  | { type: "run.steered"; accepted: boolean }
  | { type: "subagent.started" | "subagent.completed"; id?: string | null; data: Record<string, unknown> }
  | { type: "run.completed"; usage?: Usage | null; text?: string | null; pending_steer?: string }
  | { type: "run.failed"; error: string }
  | { type: "run.stopped" }
  | { type: "stream.error"; error: string }
  | { type: "unknown"; name: string; data: unknown };

export type Usage = { input_tokens?: number; output_tokens?: number; total_tokens?: number };

export const TERMINAL_EVENTS = new Set<StreamEvent["type"]>(["run.completed", "run.failed", "run.stopped", "stream.error"]);

export type Decision = "once" | "session" | "always" | "deny";

/** Wie eine Nachricht an einen laufenden Run geht: Steer schiebt sie ein, Queue stellt sie hinten an. */
export type SendMode = "steer" | "queue";

export type Item =
  | { kind: "message"; id: string; role: "user" | "assistant"; text: string; reasoning: string; streaming: boolean; images: string[]; mode?: SendMode; at?: number }
  | { kind: "tool"; id: string; name: string; preview?: string; /** Vollständige Argumente (JSON-Text), sobald der Verlauf sie kennt. */ args?: string; output?: string; status: "running" | "ok" | "error"; durationMs?: number; at?: number; /** Argumente und Ausgabe stammen aus dem Verlauf. */ enriched?: boolean }
  | { kind: "approval"; id: string; command: string; reason: string; timeoutS: number; choices: Decision[]; smartDenied: boolean; decision?: Decision; at: number; decidedAt?: number }
  | { kind: "clarify"; id: string; clarifyId?: string; question: string; choices: string[]; answer?: string; at?: number }
  | { kind: "subagent"; id: string; title: string; status: "running" | "ok" | "error"; meta: string[]; note?: string; at?: number };

export type RunStatus = "idle" | "starting" | "running" | "done" | "failed" | "stopped" | "lost";

/** Eine vorgemerkte Nachricht (Queue): wird gesendet, sobald der laufende Run fertig ist. */
export type Queued = { id: string; text: string; images: string[] };

export type ChatState = {
  items: Item[];
  runStatus: RunStatus;
  runId?: string;
  startedAt?: number;
  error?: string;
  errorCode?: string;
  usage?: Usage;
  queued: Queued[];
};

export type SessionSummary = {
  id: string;
  title: string;
  updatedAt?: number | string;
  source?: string;
  pinned?: boolean;
  messageCount?: number;
};

/** Ein Agent ist Host plus Runtime plus Profil bzw. Projekt: die Einheit in URL, Auswahl und API. */
export type AgentRef = { host: string; runtime: string; agent: string };

export type HostStatus = "online" | "sleeping" | "unreachable";
export type AgentState = "online" | "auth_error" | "unreachable" | "gone" | "unsupported";

export type AgentInfo = { id: string; label: string };
export type RuntimeInfo = {
  id: string; label: string; status: HostStatus; version: string | null; detail: string | null;
  multiplex: boolean; agents: AgentInfo[];
};
export type HostInfo = {
  id: string; label: string; kind: "local" | "remote"; address: string | null;
  status: HostStatus; detail: string | null; runtimes: RuntimeInfo[];
};
export type HostsResponse = { hosts: HostInfo[]; config_error: string | null };

export type AgentStatus = { state: AgentState; online: boolean; version: string | null; features: string[]; error: string | null };
export type Me = { user: { id: string; name: string }; auth_mode: "none" | "oidc"; fresh: boolean };

/** Sigil-Eintrag aus ui.json (WebUI-Config, nicht Hermes). `src` ist eine bereinigte SVG-URL des BFF. */
export type SigilConfig = {
  type: "glyph" | "initials" | "svg";
  glyph?: string;
  text?: string;
  src?: string;
  hue?: number | "auto" | null;
};
export type ShaderConfig = { enabled: boolean; strength: number; speed: number };
export type UiConfig = {
  ui: { backgroundShader: ShaderConfig };
  sigils: Record<string, SigilConfig>;
  /** Anzeigenamen je Profil (`host/runtime/agent` oder nur Profilname); ohne Eintrag gilt der Ordnername. */
  labels: Record<string, string>;
  /** Geladene Symbol-Packs und ihre Symbolnamen. Das Pack „neutral“ steckt im Frontend. */
  packs: Record<string, string[]>;
  /** Darf die WebUI die ui.json ändern? Sonst steht der Grund in `write_error`. */
  writable: boolean;
  write_error: string | null;
  warnings: string[];
  error: string | null;
};

/** Was die Profil-Seite zum Speichern schickt. `svg` nur bei einer neuen Datei; der Server bereinigt sie. */
export type SigilInput = { type: SigilConfig["type"]; glyph?: string; text?: string; hue: number | "auto" | null; svg?: string };
export type ProfileInput = { label: string | null; sigil: SigilInput | null };

export type DiagStatus = "ok" | "warn" | "fail";
export type DiagCheck = { id: string; label: string; status: DiagStatus; detail: string; ms: number | null };
export type DiagReport = { agent: string; status: DiagStatus; checks: DiagCheck[]; at: number };
