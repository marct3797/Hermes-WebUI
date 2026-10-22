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

export type Item =
  | { kind: "message"; id: string; role: "user" | "assistant"; text: string; reasoning: string; streaming: boolean; images: string[] }
  | { kind: "tool"; id: string; name: string; preview?: string; output?: string; status: "running" | "ok" | "error"; durationMs?: number }
  | { kind: "approval"; id: string; command: string; reason: string; timeoutS: number; choices: Decision[]; smartDenied: boolean; decision?: Decision }
  | { kind: "clarify"; id: string; clarifyId?: string; question: string; choices: string[]; answer?: string };

export type RunStatus = "idle" | "starting" | "running" | "done" | "failed" | "stopped" | "lost";

export type ChatState = {
  items: Item[];
  runStatus: RunStatus;
  runId?: string;
  error?: string;
  errorCode?: string;
  usage?: Usage;
};

export type SessionSummary = { id: string; title: string; updatedAt?: number | string; source?: string };

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
