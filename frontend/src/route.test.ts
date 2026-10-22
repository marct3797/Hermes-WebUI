import { expect, it } from "vitest";
import { parseHash, toHash } from "./route";

it("round-trips profile and session", () => {
  expect(parseHash(toHash({ profile: "co der", sessionId: "s_1" }))).toEqual({ profile: "co der", sessionId: "s_1" });
  expect(parseHash("#/p")).toEqual({ profile: "p", sessionId: undefined });
  expect(parseHash("")).toEqual({});
});
