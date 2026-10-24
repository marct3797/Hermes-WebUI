import { describe, expect, it } from "vitest";
import { agentPath, parsePath } from "./router";

describe("router", () => {
  it("knows the global pages", () => {
    expect(parsePath("/")).toEqual({ name: "cockpit" });
    expect(parsePath("/inbox")).toEqual({ name: "inbox" });
    expect(parsePath("/hosts")).toEqual({ name: "hosts" });
    expect(parsePath("/settings")).toEqual({ name: "settings" });
    expect(parsePath("/hosts/extra")).toEqual({ name: "notfound" });
    expect(parsePath("/settings/x")).toEqual({ name: "notfound" });
    expect(parsePath("/providers")).toEqual({ name: "providers" });
    expect(parsePath("/providers/x")).toEqual({ name: "notfound" });
  });

  it("parses /h/<host>/<runtime>/<agent>/<modul>/<id>", () => {
    expect(parsePath("/h/server/hermes/gamma/chat/sess_1")).toEqual({
      name: "agent", ref: { host: "server", runtime: "hermes", agent: "gamma" }, module: "chat", sessionId: "sess_1",
    });
    expect(parsePath("/h/laptop/claude-code/hermes-webui")).toMatchObject({ ref: { runtime: "claude-code", agent: "hermes-webui" }, module: "chat" });
    expect(parsePath("/h/server/hermes")).toEqual({ name: "notfound" });
  });

  it("round-trips agent paths with special characters", () => {
    const ref = { host: "server", runtime: "hermes", agent: "a b" };
    const page = parsePath(agentPath(ref, "chat", "id/1"));
    expect(page).toMatchObject({ name: "agent", ref, sessionId: "id/1" });
  });

  it("does not crash on broken percent encoding", () => {
    expect(parsePath("/h/%E0%A4%A/hermes/x")).toEqual({ name: "notfound" });
  });
});
