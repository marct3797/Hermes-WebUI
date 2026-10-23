import { describe, expect, it } from "vitest";
import { parsePath } from "./router";

describe("agent console navigation", () => {
  it.each(["kanban", "jobs", "logs", "manage", "marketplaces", "search"])("resolves %s without a placeholder", (section) => {
    expect(parsePath(`/${section}`)).toEqual({ name: "operations", section });
    expect(parsePath(`/${section}/laptop`)).toEqual({ name: "operations", section, host: "laptop" });
  });
  it.each(["terminal", "workspace"])("resolves host %s", (name) => {
    expect(parsePath(`/hosts/laptop/${name}`)).toEqual({ name, host: "laptop" });
    expect(parsePath(`/hosts/laptop/${name}/extra`)).toEqual({ name: "notfound" });
  });
  it("rejects malformed percent encoding", () => {
    expect(parsePath("/hosts/%E0%A4%A/terminal")).toEqual({ name: "notfound" });
  });
});
