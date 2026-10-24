// Fester Ersatz für das BFF in den Frontend-Tests des Pakets ext. Formen wie in backend/tests/fixtures/ext_real.json (Dashboard) nach der Umsetzung im BFF.
import type { CustomSource, Hit, McpServer, Plugin, Scan, Skill } from "../extApi";

export type Call = { method: string; path: string; query: URLSearchParams; body: Record<string, unknown> | undefined };

const hit = (name: string, identifier: string, extra: Partial<Hit> = {}): Hit => ({
  name, identifier, description: `${name}: Beispielbeschreibung`, source: "official", trust_level: "builtin", repo: null, tags: ["security"], category: null, installed: false, ...extra,
});
export const SAFE: Scan = { identifier: "", name: "", trust_level: "community", verdict: "safe", summary: "sauber", policy: "allow", policy_reason: "erlaubt", findings: [], severity_counts: {}, tier1: null };
export const CAUTION: Scan = {
  ...SAFE, verdict: "caution", policy: "ask", summary: "Hinweise",
  findings: [{ severity: "medium", category: "network", file: "run.sh", line: 9, description: "Ruft eine Adresse ab" }],
};

export class FakeBff {
  calls: Call[] = [];
  skills: Skill[] = [
    { name: "claude-code", description: "Delegate coding to Claude Code CLI", category: "autonomous-ai-agents", enabled: true, usage: 3, provenance: "bundled" },
    { name: "gamma", description: "Aus dem Hub", category: null, enabled: false, usage: 0, provenance: "hub" },
  ];
  contents: Record<string, string> = {
    "claude-code": "---\nname: claude-code\ndescription: Delegate coding\n---\n# Claude Code\n\nText.\n",
    gamma: "---\nname: gamma\ndescription: Hub\n---\n# Gamma\n",
  };
  mcp: McpServer[] = [
    { name: "rag", transport: "stdio", url: null, command: "python3", args: ["server.py"], env_names: ["EXAMPLE_API_URL"], auth: null, enabled: true, tool_count: null, source: "config", plugin: null },
    { name: "web", transport: "http", url: "https://example.com/mcp", command: null, args: [], env_names: [], auth: "oauth", enabled: true, tool_count: 2, source: "config", plugin: null },
  ];
  plugins: Plugin[] = [
    { name: "browser-firecrawl", version: "1.0.0", description: "Cloud-Browser", source: "bundled", runtime_status: "enabled", can_remove: false, can_update_git: false, auth_required: false, auth_command: "" },
    { name: "beta-plugin", version: "0.2.0", description: "Aus Git", source: "user", runtime_status: "disabled", can_remove: true, can_update_git: true, auth_required: false, auth_command: "" },
  ];
  custom: CustomSource[] = [];
  scan: Scan = SAFE;
  results: Hit[] = [hit("1password", "official/security/1password"), hit("get-pr-review", "browse-sh/github.com/get-pr-review-st0euo", { source: "browse-sh", trust_level: "community", installed: true })];
  failWith: Record<string, { status: number; detail: unknown }> = {};

  handle = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url, "http://bff.test");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path: u.pathname, query: u.searchParams, body });
    const key = `${method} ${u.pathname}`;
    for (const [part, f] of Object.entries(this.failWith)) if (key.includes(part)) return new Response(JSON.stringify({ detail: f.detail }), { status: f.status });
    const out = this.route(method, decodeURIComponent(u.pathname), u.searchParams, body);
    return new Response(JSON.stringify(out ?? { ok: true }), { status: 200 });
  };

  find = (method: string, part: string) => this.calls.filter((c) => c.method === method && c.path.includes(part));

  private route(m: string, p: string, q: URLSearchParams, b: Record<string, any> | undefined): unknown {
    let x: RegExpMatchArray | null;
    if (p === "/bff/h/server/_manage") return { profiles: [{ id: "default" }, { id: "beta" }] };
    if ((x = p.match(/^\/bff\/h\/server\/_ext\/([^/]+)\/(.*)$/))) return this.ext(m, x[2], b);
    if ((x = p.match(/^\/bff\/h\/server\/_market\/(.*)$/))) return this.market(m, x[1], q, b);
    if (p === "/bff/market/sources" && m === "GET") return { builtin: [{ id: "official-registry", label: "Offizielles MCP-Registry", kind: "mcp-registry", target: "https://registry.modelcontextprotocol.io", builtin: true }], custom: this.custom, max: 50, kinds: ["github", "well-known", "url", "mcp-registry", "plugin-git"] };
    if (p === "/bff/market/sources" && m === "POST") {
      const s = { id: `${b!.kind}-0000000${this.custom.length}`, label: b!.label as string, kind: b!.kind as string, target: b!.target as string };
      this.custom.push(s); return s;
    }
    if ((x = p.match(/^\/bff\/market\/sources\/(.*)$/)) && m === "DELETE") { this.custom = this.custom.filter((c) => c.id !== x![1]); return { ok: true }; }
    if (p === "/bff/market/registry") return { entries: [
      { name: "io.example/alpha-mcp", slug: "alpha-mcp", description: "Alpha", version: "1.2.0", repo: null, installable: true, transport: "stdio", url: null, command: "npx", args: ["-y", "alpha-mcp@1.2.0"], env: [{ name: "ALPHA_TOKEN", description: "", required: true, secret: true }] },
    ], cursor: null };
    throw new Error(`unerwartet: ${m} ${p}`);
  }

  private ext(m: string, rest: string, b: Record<string, any> | undefined): unknown {
    let x: RegExpMatchArray | null;
    if (rest === "skill-list") return { skills: this.skills };
    if ((x = rest.match(/^skills\/([^/]+)\/enabled$/))) { this.skills.find((s) => s.name === x![1])!.enabled = b!.enabled; return { ok: true }; }
    if ((x = rest.match(/^skills\/([^/]+)$/))) {
      if (m === "GET") return { name: x[1], content: this.contents[x[1]] };
      if (m === "PUT") { this.contents[x[1]] = b!.content; return { ok: true }; }
      if (m === "DELETE") { this.skills = this.skills.filter((s) => s.name !== x![1]); return { ok: true }; }
    }
    if (rest === "skills" && m === "POST") {
      this.skills.push({ name: b!.name, description: "neu", category: b!.category ?? null, enabled: true, usage: 0, provenance: "agent" }); this.contents[b!.name] = b!.content; return { ok: true, name: b!.name };
    }
    if (rest === "mcp" && m === "GET") return { servers: this.mcp };
    if (rest === "mcp" && m === "POST") {
      const s: McpServer = { name: b!.name, transport: b!.transport, url: b!.url ?? null, command: b!.command ?? null, args: b!.args ?? [], env_names: Object.keys(b!.env ?? {}), auth: null, enabled: true, tool_count: null, source: "config", plugin: null };
      this.mcp.push(s); return s;
    }
    if (rest === "mcp/catalog") return { entries: [{ name: "beta-db", description: "Datenbank-Zugriff", transport: "stdio", auth_type: "env", required_env: [{ name: "BETA_DB_KEY", prompt: "Zugangsschlüssel", required: true }], command: "npx", args: [], url: null, source: null, needs_install: false, post_install: "", installed: false, enabled: false }] };
    if (rest === "mcp/catalog/install") return { ok: true };
    if ((x = rest.match(/^mcp\/([^/]+)\/enabled$/))) { this.mcp.find((s) => s.name === x![1])!.enabled = b!.enabled; return { ok: true }; }
    if ((x = rest.match(/^mcp\/([^/]+)\/test$/))) return { ok: true, error: null, tools: [{ name: "search", description: "Suche" }, { name: "fetch", description: "Abruf" }], prompts: 0, resources: 1 };
    if ((x = rest.match(/^mcp\/([^/]+)\/auth$/))) return { flow_id: "flow_abcdefgh", status: "authorization_required", authorization_url: "https://auth.example.com/authorize" };
    if ((x = rest.match(/^mcp\/([^/]+)$/)) && m === "DELETE") { this.mcp = this.mcp.filter((s) => s.name !== x![1]); return { ok: true }; }
    if (rest === "plugins" && m === "GET") return { plugins: this.plugins };
    if (rest === "plugins/catalog") return { entries: [] };
    if (rest === "plugins/install") return { ok: true, name: "installed" };
    if ((x = rest.match(/^plugins\/([^/]+)\/(enable|disable)$/))) { this.plugins.find((s) => s.name === x![1])!.runtime_status = x[2] === "enable" ? "enabled" : "disabled"; return { ok: true }; }
    if ((x = rest.match(/^plugins\/([^/]+)$/)) && m === "DELETE") { this.plugins = this.plugins.filter((s) => s.name !== x![1]); return { ok: true }; }
    throw new Error(`unerwartet: ${m} ext/${rest}`);
  }

  private market(m: string, rest: string, q: URLSearchParams, b: Record<string, any> | undefined): unknown {
    if (rest === "sources") return { sources: [
      { id: "official", ref: "official", label: "Official (Nous)", kind: "hub", builtin: true, searchable: true },
      { id: "browse-sh", ref: "browse-sh", label: "browse.sh", kind: "hub", builtin: true, searchable: true },
      ...this.custom.filter((c) => c.kind !== "mcp-registry").map((c) => ({ ...c, ref: `custom:${c.id}`, builtin: false, searchable: true })),
    ] };
    if (rest === "skills") {
      const text = q.get("q") ?? "";
      const rows = text ? this.results.filter((r) => `${r.name} ${r.description}`.includes(text)) : this.results;
      return { results: rows, categories: ["security"], featured: !text, note: null, source_counts: {}, timed_out: [] };
    }
    if (rest === "skills/preview") return { ...this.results[0], identifier: q.get("identifier"), skill_md: "---\nname: x\ndescription: y\n---\n# Vorschau-Titel\n\nInhalt.", files: ["SKILL.md", "run.sh"] };
    if (rest === "skills/scan") return { ...this.scan, identifier: q.get("identifier") };
    if (rest === "skills/install") return { results: (b!.profiles as string[]).map((profile) => ({ profile, ok: true, error: null })), scan: this.scan };
    if (rest === "mcp") return { entries: [] };
    if (rest === "plugins") return { entries: [], categories: [], custom: this.custom.filter((c) => c.kind === "plugin-git") };
    throw new Error(`unerwartet: ${m} market/${rest}`);
  }
}
