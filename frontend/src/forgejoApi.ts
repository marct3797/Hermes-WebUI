import { call } from "./api";

export type FjInstance = { id: string; label: string; base_url: string; repos: string[]; columns: string[]; token_set: boolean };
export type FjIssue = {
  repo: string; number: number; title: string; state: "open" | "closed"; column: string; assignee: string | null; assignees: string[];
  labels: { name: string; color: string }[]; comments: number; created_at: string | null; updated_at: string | null; url: string | null; author: string | null; snippet: string;
};
export type FjIssueDetail = FjIssue & { body: string; comment_list: { id: number | null; author: string | null; body: string; created_at: string | null }[] };
export type FjPatch = Partial<{ title: string; body: string; assignee: string; column: string }>;

const q = (repo: string) => `repo=${encodeURIComponent(repo)}`;
const base = (inst: string) => `/bff/forgejo/${encodeURIComponent(inst)}`;

export const forgejoApi = {
  instances: () => call<{ instances: FjInstance[]; config_error: string | null }>("GET", "/bff/forgejo"),
  issues: (inst: string, repo: string) => call<{ issues: FjIssue[]; truncated: boolean; columns: string[] }>("GET", `${base(inst)}/issues?${q(repo)}`),
  issue: (inst: string, repo: string, n: number) => call<FjIssueDetail>("GET", `${base(inst)}/issues/${n}?${q(repo)}`),
  create: (inst: string, repo: string, b: { title: string; body: string; assignee: string }) => call<FjIssueDetail>("POST", `${base(inst)}/issues?${q(repo)}`, b),
  patch: (inst: string, repo: string, n: number, p: FjPatch) => call<FjIssueDetail>("PATCH", `${base(inst)}/issues/${n}?${q(repo)}`, p),
  comment: (inst: string, repo: string, n: number, body: string) => call<{ ok: true }>("POST", `${base(inst)}/issues/${n}/comments?${q(repo)}`, { body }),
};
