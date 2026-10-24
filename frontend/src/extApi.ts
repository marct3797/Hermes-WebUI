import { ApiError, call } from "./api";

export { ApiError };
const e = encodeURIComponent;
const ext = (host: string, profile: string) => `/bff/h/${e(host)}/_ext/${e(profile)}`;
const mk = (host: string) => `/bff/h/${e(host)}/_market`;
const qs = (o: Record<string, string | undefined>) => {
  const p = Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${e(v!)}`);
  return p.length ? `?${p.join("&")}` : "";
};

export type Skill = { name: string; description: string; category: string | null; enabled: boolean; usage: number; provenance: "bundled" | "hub" | "external" | "agent" | string };
export type McpServer = {
  name: string; transport: "stdio" | "http" | "unknown"; url: string | null; command: string | null; args: string[]; env_names: string[];
  auth: string | null; enabled: boolean; tool_count: number | null; source: "config" | "plugin"; plugin: string | null;
};
export type McpTest = { ok: boolean; error: string | null; tools: { name: string; description: string }[]; prompts: number; resources: number };
export type McpEnv = { name: string; prompt: string; required: boolean };
export type McpCatalogEntry = {
  name: string; description: string; transport: string; auth_type: string; required_env: McpEnv[]; command: string | null; args: string[]; url: string | null;
  source: string | null; needs_install: boolean; post_install: string; installed: boolean; enabled: boolean;
};
export type McpNew = { name: string; transport: "stdio" | "http"; command?: string; args?: string[]; env?: Record<string, string>; url?: string; auth?: string; bearer_token?: string };
export type OAuthFlow = { flow_id?: string; status?: string; authorization_url?: string | null; error?: string | null };
export type Plugin = {
  name: string; version: string; description: string; source: string; runtime_status: string | null; can_remove: boolean; can_update_git: boolean;
  auth_required: boolean; auth_command: string;
};
export type PluginCatalogEntry = {
  name: string; description: string; repo: string | null; maintainer: string; tier: string; category: string | null; version: string; installed: boolean;
  update_available: boolean; runtime_status: string | null; requires_env: string[];
};
export type PluginResult = { ok: boolean; consent_required?: boolean; name?: string; message?: string; capabilities?: unknown; delta?: unknown };

export type Hit = { name: string; description: string; source: string; identifier: string; trust_level: string; repo: string | null; tags: string[]; category: string | null; installed: boolean };
export type Preview = Hit & { skill_md: string; files: string[] };
export type Finding = { severity: string; category: string; file: string; line: number | null; description: string };
export type Scan = {
  identifier: string; name: string; trust_level: string; verdict: string; summary: string; policy: "allow" | "ask" | "block" | string; policy_reason: string;
  findings: Finding[]; severity_counts: Record<string, number>; tier1: { passed: boolean; findings: number } | null;
};
export type SkillSearch = { results: Hit[]; categories: string[]; featured: boolean; note: string | null; source_counts: Record<string, number>; timed_out: string[] };
export type CustomSource = { id: string; label: string; kind: string; target: string };
export type SourceList = { builtin: (CustomSource & { builtin: true })[]; custom: CustomSource[]; max: number; kinds: string[] };
export type HostSource = { id: string; ref: string; label: string; kind: string; builtin: boolean; searchable: boolean; target?: string };
export type RegistryEntry = {
  name: string; slug: string; description: string; version: string; repo: string | null; installable: boolean; transport: "stdio" | "http" | null;
  url: string | null; command: string | null; args: string[]; env: { name: string; description: string; required: boolean; secret: boolean }[];
};
export type InstallResponse = { results: { profile: string; ok: boolean; error: string | null }[]; scan: Scan };

export const extApi = {
  profiles: (host: string) => call<{ profiles: { id: string }[] }>("GET", `/bff/h/${e(host)}/_manage`),
  skills: (h: string, p: string) => call<{ skills: Skill[] }>("GET", `${ext(h, p)}/skill-list`),
  skill: (h: string, p: string, n: string) => call<{ name: string; content: string }>("GET", `${ext(h, p)}/skills/${e(n)}`),
  saveSkill: (h: string, p: string, n: string, content: string) => call<{ ok: boolean }>("PUT", `${ext(h, p)}/skills/${e(n)}`, { content }),
  createSkill: (h: string, p: string, body: { name: string; category?: string; content: string }) => call<{ ok: boolean; name: string }>("POST", `${ext(h, p)}/skills`, body),
  toggleSkill: (h: string, p: string, n: string, enabled: boolean) => call<{ ok: boolean }>("PUT", `${ext(h, p)}/skills/${e(n)}/enabled`, { enabled }),
  updateSkill: (h: string, p: string, n: string) => call<{ ok: boolean }>("POST", `${ext(h, p)}/skills/${e(n)}/update`, {}),
  uninstallSkill: (h: string, p: string, n: string) => call<{ ok: boolean }>("DELETE", `${ext(h, p)}/skills/${e(n)}`),
  mcp: (h: string, p: string) => call<{ servers: McpServer[] }>("GET", `${ext(h, p)}/mcp`),
  addMcp: (h: string, p: string, body: McpNew) => call<McpServer>("POST", `${ext(h, p)}/mcp`, body),
  toggleMcp: (h: string, p: string, n: string, enabled: boolean) => call<{ ok: boolean }>("PUT", `${ext(h, p)}/mcp/${e(n)}/enabled`, { enabled }),
  testMcp: (h: string, p: string, n: string) => call<McpTest>("POST", `${ext(h, p)}/mcp/${e(n)}/test`, {}),
  authMcp: (h: string, p: string, n: string) => call<OAuthFlow>("POST", `${ext(h, p)}/mcp/${e(n)}/auth`, {}),
  authStatus: (h: string, p: string, flow: string) => call<OAuthFlow>("GET", `${ext(h, p)}/mcp/oauth/${e(flow)}`),
  removeMcp: (h: string, p: string, n: string) => call<{ ok: boolean }>("DELETE", `${ext(h, p)}/mcp/${e(n)}`),
  mcpCatalog: (h: string, p: string) => call<{ entries: McpCatalogEntry[] }>("GET", `${ext(h, p)}/mcp/catalog`),
  installMcp: (h: string, p: string, body: { name: string; env: Record<string, string>; enable: boolean }) => call<{ ok: boolean }>("POST", `${ext(h, p)}/mcp/catalog/install`, body),
  plugins: (h: string, p: string) => call<{ plugins: Plugin[] }>("GET", `${ext(h, p)}/plugins`),
  pluginCatalog: (h: string, p: string) => call<{ entries: PluginCatalogEntry[] }>("GET", `${ext(h, p)}/plugins/catalog`),
  pluginAction: (h: string, p: string, n: string, action: "enable" | "disable" | "update", accept = false) =>
    call<PluginResult>("POST", `${ext(h, p)}/plugins/${e(n)}/${action}`, accept ? { accept_capabilities: true } : {}),
  removePlugin: (h: string, p: string, n: string) => call<{ ok: boolean }>("DELETE", `${ext(h, p)}/plugins/${e(n)}`),
  installPlugin: (h: string, p: string, body: { identifier?: string; catalog_name?: string; force?: boolean }) => call<PluginResult>("POST", `${ext(h, p)}/plugins/install`, body),

  hostSources: (h: string, p: string) => call<{ sources: HostSource[] }>("GET", `${mk(h)}/sources${qs({ profile: p })}`),
  search: (h: string, o: { q: string; source: string; category: string; profile: string }) => call<SkillSearch>("GET", `${mk(h)}/skills${qs(o)}`),
  preview: (h: string, identifier: string, profile: string) => call<Preview>("GET", `${mk(h)}/skills/preview${qs({ identifier, profile })}`),
  scan: (h: string, identifier: string, profile: string) => call<Scan>("GET", `${mk(h)}/skills/scan${qs({ identifier, profile })}`),
  install: (h: string, body: { identifier: string; profiles: string[]; accept_risk: boolean }) => call<InstallResponse>("POST", `${mk(h)}/skills/install`, body),
  marketMcp: (h: string, q: string, profile: string) => call<{ entries: McpCatalogEntry[] }>("GET", `${mk(h)}/mcp${qs({ q, profile })}`),
  marketPlugins: (h: string, o: { q: string; category: string }) =>
    call<{ entries: PluginCatalogEntry[]; categories: string[]; custom: CustomSource[] }>("GET", `${mk(h)}/plugins${qs(o)}`),
  registry: (source: string, q: string) => call<{ entries: RegistryEntry[]; cursor: string | null }>("GET", `/bff/market/registry${qs({ source, q })}`),
  sources: () => call<SourceList>("GET", "/bff/market/sources"),
  addSource: (body: { label: string; kind: string; target: string }) => call<CustomSource>("POST", "/bff/market/sources", body),
  removeSource: (id: string) => call<{ ok: boolean }>("DELETE", `/bff/market/sources/${e(id)}`),
};
