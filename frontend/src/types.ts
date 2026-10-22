/** Stabiles Event-Schema des BFF (siehe backend/app/hermes.py, normalize_event). */
export type StreamEvent =
  | { type: "run.started"; run_id?: string; session_id?: string }
  | { type: "message.delta"; text: string }
  | { type: "message.interim"; text: string }
  | { type: "reasoning.delta"; text: string }
  | { type: "tool.started"; id: string; name: string; preview?: unknown }
  | { type: "tool.completed"; id: string; name: string; ok: boolean; duration_ms?: number; output?: unknown }
  | { type: "approval.requested"; approval_id?: string; command: string; reason: string; timeout_s: number }
  | { type: "clarify.requested"; clarify_id?: string; question: string; choices?: string[] | null }
  | { type: `subagent.${string}`; id?: string; data: Record<string, unknown> }
  | { type: "run.completed"; usage?: Usage | null }
  | { type: "run.failed"; error: string }
  | { type: "run.stopped" }
  | { type: "stream.error"; error: string }
  | { type: "unknown"; name: string; data: unknown };

export type Usage = { input_tokens?: number; output_tokens?: number };

export const EVENT_NAMES = [
  "run.started", "message.delta", "message.interim", "reasoning.delta", "tool.started", "tool.completed",
  "approval.requested", "clarify.requested", "run.completed", "run.failed", "run.stopped", "stream.error", "unknown",
] as const;

export type Decision = "once" | "session" | "always" | "deny";

export type Item =
  | { kind: "message"; id: string; role: "user" | "assistant"; text: string; reasoning: string; streaming: boolean; images: string[] }
  | { kind: "tool"; id: string; name: string; preview?: string; output?: string; status: "running" | "ok" | "error"; durationMs?: number }
  | { kind: "approval"; id: string; approvalId?: string; command: string; reason: string; timeoutS: number; decision?: Decision }
  | { kind: "clarify"; id: string; clarifyId?: string; question: string; choices: string[]; answer?: string };

export type RunStatus = "idle" | "starting" | "running" | "done" | "failed" | "stopped" | "lost";

export type ChatState = {
  items: Item[];
  runStatus: RunStatus;
  runId?: string;
  error?: string;
  usage?: Usage;
};

export type SessionSummary = { id: string; title: string; updatedAt?: number | string; source?: string };
export type Profile = { name: string; label: string };
