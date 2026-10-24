import { call } from "./api";

export type Workspace = { id: string; label: string; is_git?: boolean };
export type Entry = { name: string; path: string; kind: "directory" | "file"; size?: number; mtime?: number };
export type FileRead = { entries?: Entry[]; content?: string; truncated?: boolean; mime?: string; sha256?: string; size?: number | null; editable?: boolean };
export type GitFile = { path: string; state: string };
export type GitCommit = { hash: string; subject: string; author: string; date: string };
export type Git = {
  repository?: boolean; reason?: string; branch: string; status: string; diff: string; truncated?: boolean;
  files?: GitFile[]; log?: GitCommit[]; branches?: { name: string; current: boolean }[]; remotes: { name: string; url: string }[];
};

export const EDIT_LIMIT = 1048576;
/** Endungen, die nie als Text geöffnet werden (nur Download). */
export const BINARY_RE = /\.(pdf|png|jpe?g|gif|webp|zip|gz|woff2?|exe|bin)$/i;

export const hostFiles = (host: string) => {
  const base = `/bff/h/${encodeURIComponent(host)}`;
  const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
  return {
    workspaces: (signal?: AbortSignal) => call<{ workspaces: Workspace[] }>("GET", `${base}/_workspaces`, undefined, signal),
    list: (workspace: string, path: string, signal?: AbortSignal) => call<FileRead>("GET", `${base}/_files?${q({ workspace, path })}`, undefined, signal),
    read: (workspace: string, path: string, signal?: AbortSignal) => call<FileRead>("GET", `${base}/_files?${q({ workspace, path, full: "true" })}`, undefined, signal),
    git: (workspace: string, signal?: AbortSignal) => call<Git>("GET", `${base}/_git?${q({ workspace })}`, undefined, signal),
    write: (workspace: string, path: string, content: string, expected_sha256?: string) =>
      call<{ sha256: string; size: number }>("PUT", `${base}/_files/write`, { workspace, path, content, ...(expected_sha256 ? { expected_sha256 } : { create: true }) }),
    mkdir: (workspace: string, path: string) => call<unknown>("POST", `${base}/_files/mkdir`, { workspace, path }),
    move: (workspace: string, from: string, to: string) => call<unknown>("POST", `${base}/_files/move`, { workspace, from, to }),
    upload: (workspace: string, path: string, content_base64: string) => call<unknown>("POST", `${base}/_files/upload`, { workspace, path, content_base64 }),
    downloadUrl: (workspace: string, path: string) => `${base}/_files/download?${q({ workspace, path })}`,
  };
};
export type HostFiles = ReturnType<typeof hostFiles>;

/** Der Abschnitt des Gesamt-Diffs, der zu einer Datei gehört (leer, wenn keiner da ist). */
export function diffFor(diff: string, path: string): string {
  const parts = diff.split(/^(?=diff --git )/m);
  return parts.find((p) => p.startsWith(`diff --git a/${path} b/`)) ?? "";
}

export const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
export const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");
