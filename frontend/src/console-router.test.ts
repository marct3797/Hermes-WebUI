import { describe, expect, it } from "vitest";
import { parsePath } from "./router";

describe("agent console navigation", () => {
  it("resolves the search section", () => {
    expect(parsePath("/search")).toEqual({ name: "operations", section: "search" });
    expect(parsePath("/search/laptop")).toEqual({ name: "operations", section: "search", host: "laptop" });
  });
  it.each([["kanban", "kanban"], ["jobs", "jobs"], ["logs", "logs"], ["extensions", "extensions"], ["manage", "extensions"], ["marketplace", "marketplace"], ["marketplaces", "marketplace"]])("resolves /%s to the %s page", (path, name) => {
    expect(parsePath(`/${path}`)).toEqual({ name });
    expect(parsePath(`/${path}/laptop`)).toEqual({ name, host: "laptop" });
  });
  it.each(["terminal", "workspace"])("resolves host %s", (name) => {
    expect(parsePath(`/hosts/laptop/${name}`)).toEqual({ name, host: "laptop" });
    expect(parsePath(`/hosts/laptop/${name}/extra`)).toEqual({ name: "notfound" });
  });
  it("rejects malformed percent encoding", () => {
    expect(parsePath("/hosts/%E0%A4%A/terminal")).toEqual({ name: "notfound" });
  });
});
