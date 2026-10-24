import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { useSessions } from "./shell";
import type { AgentRef } from "./types";

const AGENT: AgentRef = { host: "server", runtime: "hermes", agent: "gamma" };
const row = (n: number, extra: Record<string, unknown> = {}) => ({ id: `s${n}`, title: `Chat ${n}`, last_active: 1_000 - n, ...extra });

afterEach(() => vi.restoreAllMocks());

describe("useSessions", () => {
  it("loads the next page from the raw row count, even when some rows are hidden", async () => {
    const calls: Array<[number, number]> = [];
    vi.spyOn(api, "sessions").mockImplementation(async (_a, offset = 0, limit = 30) => {
      calls.push([offset, limit]);
      // Seite 1: 3 Zeilen, eine davon archiviert (nicht sichtbar); Seite 2: 2 Zeilen, keine weitere.
      return offset === 0
        ? { data: [row(1), row(2, { archived: true }), row(3)], has_more: true }
        : { data: [row(4), row(5)], has_more: false };
    });
    const { result } = renderHook(() => useSessions(AGENT));
    await waitFor(() => expect(result.current.sessions.map((s) => s.id)).toEqual(["s1", "s3"]));
    expect(result.current.hasMore).toBe(true);

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.sessions.map((s) => s.id)).toEqual(["s1", "s3", "s4", "s5"]));
    expect(calls[1]).toEqual([3, 30]); // 3 Rohzeilen geladen, nicht 2 sichtbare
    expect(result.current.hasMore).toBe(false);
  });

  it("keeps the loaded pages when the list is refreshed", async () => {
    const limits: number[] = [];
    vi.spyOn(api, "sessions").mockImplementation(async (_a, offset = 0, limit = 30) => {
      limits.push(limit);
      return { data: Array.from({ length: Math.max(0, Math.min(limit, 45 - offset)) }, (_, i) => row(offset + i)), has_more: offset + limit < 45 };
    });
    const { result } = renderHook(() => useSessions(AGENT));
    await waitFor(() => expect(result.current.sessions).toHaveLength(30));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.sessions).toHaveLength(45));
    act(() => result.current.refresh());
    await waitFor(() => expect(limits.at(-1)).toBe(45));
    expect(result.current.sessions).toHaveLength(45);
  });

  it("renames and removes locally after the server accepted it", async () => {
    vi.spyOn(api, "sessions").mockResolvedValue({ data: [row(1), row(2)], has_more: false });
    const rename = vi.spyOn(api, "renameSession").mockResolvedValue({});
    const del = vi.spyOn(api, "deleteSession").mockResolvedValue({});
    const { result } = renderHook(() => useSessions(AGENT));
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));
    await act(() => result.current.rename("s1", "Neu"));
    expect(rename).toHaveBeenCalledWith(AGENT, "s1", "Neu");
    expect(result.current.sessions[0].title).toBe("Neu");
    await act(() => result.current.remove("s2"));
    expect(del).toHaveBeenCalledWith(AGENT, "s2");
    expect(result.current.sessions.map((s) => s.id)).toEqual(["s1"]);
  });

  it("does not change the list when the server refuses", async () => {
    vi.spyOn(api, "sessions").mockResolvedValue({ data: [row(1)], has_more: false });
    vi.spyOn(api, "deleteSession").mockRejectedValue(new Error("session_busy"));
    const { result } = renderHook(() => useSessions(AGENT));
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    await expect(act(() => result.current.remove("s1"))).rejects.toThrow("session_busy");
    expect(result.current.sessions).toHaveLength(1);
  });
});
