import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { resetRedirect } from "./api";
import { cached, invalidate, peek } from "./dataCache";
import { poll } from "./poll";
import { installBackend } from "./test-backend";

const setVisibility = (state: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
};

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setVisibility("visible"); });

describe("Abfragen der Cockpit-Seite in 60 s (gezählter Fake-Fetch)", () => {
  beforeEach(() => { resetRedirect(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }); });

  async function requestsIn60s(visibility: "visible" | "hidden") {
    const { calls } = installBackend(["raiden", "sora"]);
    history.pushState(null, "", "/");
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); // Start: me, hosts, ui, rooms, Sessions je Agent
    expect(calls.some((c) => c.url === "/bff/hosts")).toBe(true);
    setVisibility(visibility);
    const before = calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    const fresh = calls.slice(before).filter((c) => c.url.startsWith("/bff/")).map((c) => c.url);
    const count = (u: string) => fresh.filter((x) => x === u).length;
    console.log(`[PERF] Cockpit 60 s, Tab ${visibility}: hosts=${count("/bff/hosts")} rooms=${count("/bff/rooms")} gesamt=${fresh.length}`);
    return { hosts: count("/bff/hosts"), rooms: count("/bff/rooms"), total: fresh.length };
  }

  it("polls hosts every 30 s and rooms every 15 s while the tab is visible", async () => {
    const r = await requestsIn60s("visible");
    expect(r.hosts).toBe(2);
    expect(r.rooms).toBe(4);
  });

  it("sends no polling requests while the tab is hidden", async () => {
    const r = await requestsIn60s("hidden");
    expect(r.total).toBe(0);
  });
});

describe("poll", () => {
  beforeEach(() => vi.useFakeTimers());

  it("backs off after errors, resets after success and refreshes when the tab returns", async () => {
    const fn = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error("x")).mockRejectedValueOnce(new Error("x")).mockResolvedValue(undefined);
    const stop = poll(fn, 1000);
    await vi.advanceTimersByTimeAsync(1000); // 1. Fehler, nächster Abstand 2 s
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // 2. Fehler, nächster Abstand 4 s
    await vi.advanceTimersByTimeAsync(4000); // Erfolg: zurück auf 1 s
    expect(fn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(4);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fn).toHaveBeenCalledTimes(4);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(5);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it("does not start a second request while the last one is still running", async () => {
    let release: () => void = () => undefined;
    const fn = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const stop = poll(fn, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    setVisibility("hidden");
    setVisibility("visible");
    expect(fn).toHaveBeenCalledTimes(1);
    release();
    stop();
  });
});

describe("dataCache", () => {
  beforeEach(() => vi.useFakeTimers());

  it("shares one request, serves fresh answers from memory and refetches after the TTL or invalidate", async () => {
    const load = vi.fn(async () => ({ n: Math.random() }));
    const [a, b] = await Promise.all([cached("k", 5000, load), cached("k", 5000, load)]);
    expect(a).toBe(b);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await cached("k", 5000, load)).toBe(a);
    expect(peek("k")).toBe(a);
    vi.advanceTimersByTime(5001);
    expect(await cached("k", 5000, load)).not.toBe(a);
    invalidate("k");
    expect(peek("k")).toBeUndefined();
    await cached("k", 5000, load);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("aborts the shared request only when every waiter has gone", async () => {
    let signal!: AbortSignal;
    const load = (s: AbortSignal) => { signal = s; return new Promise<string>(() => undefined); };
    const one = new AbortController(), two = new AbortController();
    const p1 = cached("a", 5000, load, one.signal), p2 = cached("a", 5000, load, two.signal);
    one.abort();
    await expect(p1).rejects.toMatchObject({ name: "AbortError" });
    expect(signal.aborted).toBe(false);
    two.abort();
    await expect(p2).rejects.toMatchObject({ name: "AbortError" });
    expect(signal.aborted).toBe(true);
  });

  it("does not keep failed answers", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("aus")).mockResolvedValue("ok");
    await expect(cached("f", 5000, load)).rejects.toThrow("aus");
    expect(await cached("f", 5000, load)).toBe("ok");
  });
});

describe("Seitenwechsel", () => {
  it("does not refetch hosts, ui or the cockpit sessions when coming back within seconds", async () => {
    resetRedirect();
    const { calls } = installBackend(["raiden", "sora"]);
    history.pushState(null, "", "/");
    render(<App />);
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/sessions")).length).toBeGreaterThanOrEqual(2));
    const seen = () => calls.filter((c) => /^\/bff\/(hosts|ui)$|\/(raiden|sora)\/sessions$/.test(c.url)).length;
    fireEvent.click(screen.getAllByRole("link", { name: "System" })[0]);
    await screen.findByRole("heading", { name: "System", level: 1 });
    const mid = seen();
    fireEvent.click(screen.getAllByRole("link", { name: "Cockpit" })[0]);
    await screen.findByRole("region", { name: "Kennzahlen" }).catch(() => screen.findByRole("group", { name: "Kennzahlen" }));
    expect(seen()).toBe(mid);
  });
});
