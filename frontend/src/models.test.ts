import { describe, expect, it } from "vitest";
import { parseModelOptions } from "./models";

describe("parseModelOptions", () => {
  it("reads Hermes' provider list and the current model", () => {
    const o = parseModelOptions({
      providers: [
        { slug: "nous", name: "Nous", authenticated: false, models: [] },
        { slug: "opencode-go", name: "OpenCode Go", is_current: true, authenticated: true, models: ["muse-spark-1.3-contributor", { id: "kimi-k2" }], featured_models: ["kimi-k2"] },
        { slug: "fireworks", name: "Fireworks", authenticated: false, models: ["x"] },
      ],
      model: "muse-spark-1.3-contributor", provider: "opencode-go",
    });
    expect(o.groups).toEqual([{ provider: "opencode-go", label: "OpenCode Go", models: ["muse-spark-1.3-contributor", "kimi-k2"] }]);
    expect(o).toMatchObject({ current: "muse-spark-1.3-contributor", provider: "opencode-go" });
  });

  it("keeps the current provider even when it reports no login", () => {
    const o = parseModelOptions({ providers: [{ slug: "p", is_current: true, authenticated: false, models: ["m"] }], model: "m" });
    expect(o.groups).toHaveLength(1);
  });

  it("still reads the flat list of the mock and plain arrays", () => {
    expect(parseModelOptions({ models: [{ id: "a", provider: "mock" }, "b"], current: "a" })).toEqual({
      groups: [{ provider: "mock", label: "mock", models: ["a"] }, { provider: "", label: "Modelle", models: ["b"] }], current: "a", provider: undefined,
    });
    expect(parseModelOptions(["x"]).groups[0].models).toEqual(["x"]);
    expect(parseModelOptions(null)).toEqual({ groups: [], current: undefined, provider: undefined });
  });
});
