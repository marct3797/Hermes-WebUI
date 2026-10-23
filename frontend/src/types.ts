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
export type Me = { user: { id: string; name: string }; auth_mode: "none" | "oidc"; fresh: boolean; build?: string | null };

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

export type MemProvider = { id: string; type: string; label: string; bank: string; capabilities: string[] };
export type MemItem = { id: string; text: string; kind: string | null; context: string | null; entities: string[]; at: number | null; tags: string[]; document: string | null };
export type MemPage = { items: MemItem[]; total: number | null; limit: number; offset: number };
export type MemGraph = { nodes: Array<{ id: string; label: string; kind: string | null }>; edges: Array<{ source: string; target: string; label: string | null }>; total: number; truncated: boolean };
export type MemEntity = { id: string; name: string; mentions: number; first_seen: number | null; last_seen: number | null };
export type MemModel = { id: string; name: string; content: string | null; query: string | null; updated: number | null; tags: string[] };
export type SkillInfo = { name: string; description?: string; category?: string };
export type ToolsetInfo = { name: string; label?: string; description?: string; enabled?: boolean; configured?: boolean; tools?: string[] };

export type DashboardProfile = {
  name: string; model: string | null; provider: string | null; description: string; description_auto: boolean;
  skill_count: number; gateway_running: boolean; has_env: boolean;
};
export type DashboardStatus = { available: boolean; reason: string | null; profile: DashboardProfile | null };
export type SoulEntry = { id: string; at: string; reason: string; chars: number };
export type SoulState = { content: string; exists: boolean; hash: string; max_chars: number; history: SoulEntry[] };
export type SoulSaved = { changed: boolean; hash: string; history: SoulEntry[] };
export type SoulVersion = { id: string; at: string; reason: string; content: string };

export type ProviderKey = { var: string; set: boolean; redacted: string | null; description: string; url: string | null; secret: boolean; advanced: boolean };
export type ProviderOauth = { logged_in: boolean; flow: string | null; source: string | null; expires_at: string | null; cli_command: string | null; docs_url: string | null };
export type ProviderUsage = { sessions: number; input_tokens: number; output_tokens: number; cost_usd: number; last_used_at: number | null; models: string[] };
export type ProviderGroup = { id: string; label: string; keys: ProviderKey[]; oauth: ProviderOauth | null; usage: ProviderUsage | null; configured: boolean; used: boolean };
export type ProvidersOverview = { providers: ProviderGroup[]; period_days: number; warnings: string[] };
export type KeyCheck = { ok: boolean; reachable: boolean; message: string };

export type RoomMember = AgentRef & { label: string; key: string };
export type RoomMessage = { seq: number; author: string; kind: "message" | "system"; text: string; mentions: string[]; at: number };
/** Freigabe oder Rückfrage, auf die der Lauf eines Mitglieds wartet. Der Server hält sie, solange der Lauf wartet. */
export type RoomAsk =
  | { kind: "approval"; member: string; run_id: string; command: string; reason: string; choices: Decision[]; timeout_s?: number | null; at: number }
  | { kind: "clarify"; member: string; run_id: string; clarify_id?: string | null; question: string; choices: string[]; at: number };
export type Room = {
  id: string; name: string; archived: boolean; needs_user: boolean; created_at: number;
  running: boolean; speaker: string | null; asks: RoomAsk[]; members: RoomMember[]; last_message?: RoomMessage | null; messages?: RoomMessage[];
};
export type RoomEvent =
  | { type: "state"; running: boolean; speaker: string | null; asks: RoomAsk[] }
  | { type: "asks"; asks: RoomAsk[] }
  | { type: "message"; message: RoomMessage }
  | { type: "turn.started"; turn: string }
  | { type: "member.started"; member: string; round: number }
  | { type: "member.passed"; member: string }
  | { type: "member.event"; member: string; run_id: string; event: StreamEvent }
  | { type: "turn.finished"; turn: string; reason: "idle" | "max_rounds" | "max_messages" | "needs_user" | "stopped" | "error" };
