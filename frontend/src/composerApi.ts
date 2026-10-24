import { call } from "./api";
import type { AgentRef } from "./types";

const enc = encodeURIComponent;
const base = (a: AgentRef) => `/bff/h/${enc(a.host)}/${enc(a.runtime)}/${enc(a.agent)}`;

/** `webui`: die WebUI führt den Befehl aus. `terminal`/`messaging`: Hermes verarbeitet ihn nur dort, nicht über die API. */
export type SlashCommand = {
  name: string; aliases: string[]; description: string; category: string; args_hint: string;
  status: "webui" | "terminal" | "messaging"; note: string;
};
export type RefResult = { raw: string; kind: string; ok: boolean; tokens: number; passthrough: boolean; error: string | null };
export type ExpandResult = { text: string; refs: RefResult[]; tokens: number; blocked: boolean; warnings: string[] };
export type Workspace = { id: string; label: string };
export type FileEntry = { name: string; path: string; kind: "file" | "directory"; size: number };

export const composerApi = {
  commands: (a: AgentRef) => call<{ commands: SlashCommand[] }>("GET", `${base(a)}/_commands`),
  skill: (a: AgentRef, name: string, instruction: string) => call<{ text: string }>("POST", `${base(a)}/_skill`, { name, instruction }),
  expand: (host: string, workspace: string | undefined, text: string) =>
    call<ExpandResult>("POST", `/bff/h/${enc(host)}/_composer/expand`, { workspace: workspace || undefined, text }),
  workspaces: (host: string) => call<{ workspaces: Workspace[] }>("GET", `/bff/h/${enc(host)}/_workspaces`),
  files: (host: string, workspace: string, path: string) =>
    call<{ entries: FileEntry[] }>("GET", `/bff/h/${enc(host)}/_files?${new URLSearchParams({ workspace, path })}`),
};
