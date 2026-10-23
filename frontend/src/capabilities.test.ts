import { describe, expect, it } from "vitest";
import { parseSkills, parseToolsets } from "./capabilities";

describe("parseSkills", () => {
  it("reads Hermes' list form and sorts by category, then name", () => {
    const out = parseSkills({ object: "list", data: [
      { name: "plan", description: "Zerlegt Aufgaben.", category: "software-development" },
      { name: "himalaya", category: "email" },
      { name: "alpha" },
    ] });
    expect(out.map((s) => s.name)).toEqual(["himalaya", "plan", "alpha"]);
    expect(out[1].description).toBe("Zerlegt Aufgaben.");
  });
  it("accepts a bare list and the `skills` key, and ignores junk", () => {
    expect(parseSkills([{ id: "x" }, null, 3, { name: "" }]).map((s) => s.name)).toEqual(["x"]);
    expect(parseSkills({ skills: [{ name: "y" }] })).toHaveLength(1);
    expect(parseSkills(null)).toEqual([]);
    expect(parseSkills({ data: "kaputt" })).toEqual([]);
  });
});

describe("parseToolsets", () => {
  it("keeps the enabled and configured flags and the tool names", () => {
    const [t] = parseToolsets({ data: [{ name: "web", label: "Web", enabled: true, configured: false, tools: ["web_search", { name: "web_extract" }, 5] }] });
    expect(t).toMatchObject({ name: "web", label: "Web", enabled: true, configured: false, tools: ["web_search", "web_extract"] });
  });
  it("leaves unknown flags undefined instead of guessing", () => {
    const [t] = parseToolsets([{ name: "terminal" }]);
    expect(t.enabled).toBeUndefined();
    expect(t.configured).toBeUndefined();
    expect(t.tools).toBeUndefined();
  });
});
