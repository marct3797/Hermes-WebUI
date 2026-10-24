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
export type DiagCheck = { id: string; label: string; status: DiagStatus | "slow"; // "slow": Zeitlimit der Prüfung überschritten
  detail: string; ms: number | null };
export type DiagReport = { agent: string; status: DiagStatus; checks: DiagCheck[]; at: number };

export type KnowledgeProvider = { id: string; label: string; type: string; has_sources: boolean };
export type KnowledgeStats = { reachable: boolean; reason?: string; collection?: string; count?: number; embedding_model?: string; chunk_size?: number; chunk_overlap?: number; documents?: number | null; sources?: number | null };
export type KnowledgeSource = { source: string; chunks: number; documents: number; repos: string[] };
export type KnowledgeSources = { available: boolean; reason: string | null; items: KnowledgeSource[]; scanned_chunks: number; truncated: boolean; cache_age_s: number };
export type KnowledgeDoc = { sync_id: string; source: string; repo: string | null; path: string | null; commit: string | null; chunks: number; title: string | null };
export type KnowledgeDocs = { available: boolean; reason: string | null; items: KnowledgeDoc[]; total: number };
export type KnowledgeHit = { text: string; score: number; source: string | null; repo: string | null; path: string | null; commit: string | null; sync_id: string | null; url: string | null };
export type MemProvider = { id: string; type: string; label: string; bank: string; capabilities: string[] };
export type MemItem = { id: string; text: string; kind: string | null; context: string | null; entities: string[]; at: number | null; tags: string[]; document: string | null };
export type MemPage = { items: MemItem[]; total: number | null; limit: number; offset: number };
export type MemNode = { id: string; label: string; text: string | null; date: string | null; context: string | null; entities: string[]; kind: string | null };
export type MemEdge = { source: string; target: string; type: string | null; weight?: number; entity?: string };
export type MemRow = { id: string; text: string | null; context: string | null; entities: string[]; date: string | null; kind: string | null };
export type MemGraph = { nodes: MemNode[]; edges: MemEdge[]; table_rows: MemRow[]; total: number; limit: number; returned: number; truncated: boolean; edges_dropped: number };
export type MemSeries = { points: Array<{ t: string; count: number }> };
export type MemEntity = { id: string; name: string; mentions: number; first_seen: number | null; last_seen: number | null };
export type MemModel = { id: string; name: string; content: string | null; query: string | null; updated: number | null; tags: string[] };
export type SkillInfo = { name: string; description?: string; category?: string; enabled?: boolean; provenance?: string };
export type ToolsetInfo = { name: string; label?: string; description?: string; enabled?: boolean; configured?: boolean; tools?: string[] };

export type DashboardProfile = {
  name: string; model: string | null; provider: string | null; description: string; description_auto: boolean;
  skill_count: number; gateway_running: boolean; has_env: boolean;
};
export type DashboardStatus = { available: boolean; reason: string | null; profile: DashboardProfile | null };
export type SoulEntry = { id: string; at: string; reason: string; chars: number };
export type SoulState = { content: string; exists: boolean; hash: string; max_chars: number; history: SoulEntry[] };
export type SoulSaved = { changed: boolean; hash: string; history: SoulEntry[] };
export type ConfigField = { key: string; type: "string" | "text" | "number" | "boolean" | "select" | "list"; description: string; category: string; options?: string[]; value?: unknown; secret?: boolean; set?: boolean };
export type HermesConfig = { fields: ConfigField[]; category_order: string[] };
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

// --- Anbieter-Hauptseite: alle Profile einer Runtime, Zugänge auf dem Host, Anmeldung ---
export type MatrixProfile = { name: string; model: string | null; provider: string | null; default: boolean; gateway_running: boolean; error: string | null };
export type AccountState = { configured: boolean; via: "login" | "key" | null; detail: string | null };
export type HostAccount = { id: string; label: string; cli: string; login: "device" | "pkce" | "key"; provider: string; hint: string; profiles: Record<string, AccountState> };
export type ProviderMatrix = { available: boolean; reason: string | null; profiles: MatrixProfile[]; accounts: HostAccount[] };
export type ModelProvider = { slug: string; name: string; current: boolean; authenticated: boolean; models: string[]; warning: string | null };
export type OAuthStart = { session_id: string; flow?: string; user_code?: string; verification_url?: string; auth_url?: string; expires_in?: number; poll_interval?: number };
export type OAuthPoll = { session_id: string; status: "pending" | "approved" | "error" | "expired" | string; error_message: string | null; expires_at: number | null };

export type CliAuthEntry = { id: string; state: "signed_in" | "signed_out" | "unknown"; method: string | null; checked_at: string | null; reason: string | null };
/** Anmeldeschutz (Step-up) und ob der OIDC-Anbieter die Frische der Anmeldung belegen kann. */
export type Security = { step_up: { enabled: boolean; window_s: number; proof: "off" | "auth_time" | "prompt_login_only" | "unknown" | "unavailable" } };
export type CliAuth = { available: boolean; reason: string | null; clis?: CliAuthEntry[] };
/** Restkontingente (BFF, aus dem Dashboard-Plugin ai-usage-tracker). */
export type QuotaWindow = { label: string; used_percent: number | null; remaining_percent: number | null; reset_at: string | null; reset_in_s: number | null; detail: string | null };
export type QuotaState = "ok" | "exhausted" | "low" | "unavailable" | "auth_failed";
export type QuotaProvider = { id: string; label: string; configured: boolean; active: boolean; quota_capable: boolean; plan: string | null; state: QuotaState; worst_remaining_percent: number | null; windows: QuotaWindow[]; reason: string | null };
export type Quota = { state: "ok" | "plugin_missing" | "dashboard_unavailable" | "error"; reason: string | null; generated_at: string; cached: boolean; providers: QuotaProvider[] };
export type QuotaItem = { host: string; runtime: string; profile: string; provider: string; label: string; state: QuotaState; remaining_percent: number | null; window: string | null; reset_in_s: number | null; reason: string | null };
export type QuotaSummary = { runtimes: Array<{ host: string; runtime: string; state: Quota["state"]; reason: string | null }>; items: QuotaItem[]; worst: QuotaItem | null };

/** Werkzeug-Gruppen eines Profils (vom Dashboard): Zustand, Anbieter mit „Schlüssel gesetzt“, nie ein Wert. */
export type ToolsetRow = { name: string; label?: string; description?: string; platform?: string; enabled: boolean; configured: boolean; tools?: string[] };
export type ToolEnvVar = { key: string; prompt?: string; url?: string | null; is_set: boolean };
export type ToolProvider = { name: string; badge?: string; tag?: string; post_setup?: string | null; requires_nous_auth?: boolean; is_active?: boolean; status?: string; web_backend?: string; capabilities?: string[]; env_vars: ToolEnvVar[] };
export type ToolConfig = { name: string; has_category: boolean; active_provider: string | null; providers: ToolProvider[] };
export type ToolModel = { id: string; display?: string; speed?: string; strengths?: string; price?: string };
export type ToolModels = { name: string; has_models: boolean; provider?: string | null; models: ToolModel[]; current: string | null; default: string | null };
export type TerminalBackend = { name: string; label?: string; description?: string; active?: boolean; status?: string; detail?: string };
export type TerminalBackends = { active: string | null; backends: TerminalBackend[] };
