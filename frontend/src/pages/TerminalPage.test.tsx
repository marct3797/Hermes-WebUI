import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TerminalPage } from "./TerminalPage";
import exited from "../fixtures/real/real_terminals_after_exit.json";
import info from "../fixtures/real/real_hostd_info.json";

const xterm = vi.hoisted(() => ({ write: vi.fn(), dispose: vi.fn(), reset: vi.fn(), fit: vi.fn(), input: undefined as undefined | ((data: string) => void) }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols = 80; rows = 24; options = {};
  open() {} loadAddon() {} focus() {} reset = xterm.reset; write = xterm.write; dispose = xterm.dispose;
  onData(cb: (data: string) => void) { xterm.input = cb; return { dispose() {} }; }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = xterm.fit; } }));
class Socket {
  static all: Socket[] = []; readyState = 1; send = vi.fn(); close = vi.fn();
  onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: () => void; onerror?: () => void;
  constructor(public url: string) { Socket.all.push(this); }
  frame(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
}
const terminal = { id: "t1", cli: "codex", workspace: "repo", running: true, pid: 1, created_at: 0 };
function setup(available = true) {
  Socket.all = [];
  vi.stubGlobal("WebSocket", Socket);
  const fetcher = vi.fn(async (url: string, opts?: RequestInit) => ({ ok: true, json: async () => url.endsWith("_hostd") ? { available, reason: "Nicht eingerichtet", clis: [{ id: "codex", label: "Codex", available: true }], workspaces: [{ id: "repo", label: "Repository" }] } : opts?.method === "POST" ? terminal : { terminals: [terminal] } }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("terminal", () => {
  it("reattaches without starting work, replays bytes, resizes and sends mobile keys", async () => {
    const fetcher = setup();
    const view = render(<TerminalPage host="laptop" />);
    await waitFor(() => expect(Socket.all).toHaveLength(1));
    const ws = Socket.all[0];
    expect(ws.url).toContain("/bff/h/laptop/_terminals/t1/stream?after=0");
    act(() => { ws.onopen?.(); ws.frame({ type: "output", offset: 0, data: btoa("hello") }); });
    expect(xterm.write).toHaveBeenCalledWith(new Uint8Array([104, 101, 108, 108, 111]));
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    fireEvent.click(screen.getByRole("button", { name: "Ctrl+C" }));
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "input", data: btoa("\x03") }));
    act(() => ws.frame({ type: "gap", available_from: 5 }));
    expect(screen.getByRole("alert")).toHaveTextContent("Ausgabe");
    fireEvent.click(screen.getByRole("button", { name: "Neu verbinden" }));
    await waitFor(() => expect(Socket.all).toHaveLength(2));
    expect(Socket.all[1].url).toContain("after=5");
    view.unmount();
    expect(fetcher.mock.calls.some(([, opts]) => opts?.method === "DELETE" || opts?.method === "POST")).toBe(false);
    expect(xterm.dispose).toHaveBeenCalled();
  });
  it("preselects the CLI from the query and shows its sign-in state without blocking start", async () => {
    setup();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async (): Promise<unknown> =>
      url.endsWith("_hostd") ? { available: true, clis: [{ id: "codex", label: "Codex", available: true }, { id: "claude", label: "Claude", available: true }], workspaces: [{ id: "repo", label: "Repository" }] }
      : url.endsWith("_cli-auth") ? { available: true, reason: null, clis: [{ id: "claude", state: "signed_out", method: null, checked_at: "x", reason: null }] } : { terminals: [] } })));
    history.pushState(null, "", "/hosts/laptop/terminal?cli=claude");
    render(<TerminalPage host="laptop" />);
    expect(await screen.findByText(/Anmeldung: abgemeldet/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /^CLI/ })).toHaveValue("claude");
    expect(screen.getByRole("button", { name: "Terminal starten" })).toBeEnabled();
    history.pushState(null, "", "/");
  });
  it("shows an explicit unconfigured state", async () => {
    setup(false); render(<TerminalPage host="server" />);
    expect(await screen.findByText("Nicht eingerichtet")).toBeInTheDocument();
    expect(Socket.all).toHaveLength(0);
  });
  it("shows an exited terminal (real shape) as Beendet with Exit code and closes it via DELETE", async () => {
    Socket.all = []; vi.stubGlobal("WebSocket", Socket);
    let list: unknown[] = exited.terminals;
    const fetcher = vi.fn(async (url: string, opts?: RequestInit) => {
      if (opts?.method === "DELETE") { list = []; return { ok: true, json: async () => ({ ok: true }) }; }
      return { ok: true, json: async () => url.endsWith("_hostd") ? info : { terminals: list } };
    });
    vi.stubGlobal("fetch", fetcher);
    render(<TerminalPage host="laptop" />);
    expect((await screen.findAllByText(/Beendet · Exit 0/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/gestartet vor/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Schließen" }));
    await waitFor(() => expect(fetcher.mock.calls.some(([url, o]) => o?.method === "DELETE" && String(url).endsWith(`/_terminals/${exited.terminals[0].id}`))).toBe(true));
    expect(await screen.findByText(/Keine Terminals/)).toBeInTheDocument();
  });
});

const fail = (status: number, detail = "Host-Dienst antwortet mit HTTP " + status) => ({ ok: false, status, statusText: "x", json: async () => ({ detail }) });
describe("terminal robustness", () => {
  const hostd = (extra: object = {}) => ({ version: "0.3.0", available: true, clis: [{ id: "codex", label: "Codex", available: true }], workspaces: [{ id: "repo", label: "Repository" }], ...extra });
  beforeEach(() => { Socket.all = []; vi.stubGlobal("WebSocket", Socket); });

  it("explains a missing workspace configuration with the command and blocks the start", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith("_hostd") ? hostd({ workspaces: [] }) : { terminals: [] } })));
    render(<TerminalPage host="laptop" />);
    expect(await screen.findByText(/Kein Arbeitsordner konfiguriert/)).toHaveTextContent("python -m hostd.workspaces add");
    expect(screen.getByRole("button", { name: "Terminal starten" })).toBeDisabled();
  });

  it("explains start failures (400) and an outdated host service (404) in German", async () => {
    let status = 400;
    vi.stubGlobal("fetch", vi.fn(async (url: string, opts?: RequestInit) => opts?.method === "POST" ? fail(status) : { ok: true, json: async () => url.endsWith("_hostd") ? hostd() : { terminals: [] } }));
    render(<TerminalPage host="laptop" />);
    const start = await screen.findByRole("button", { name: "Terminal starten" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    expect(await screen.findByRole("alert")).toHaveTextContent("CLI oder Arbeitsordner sind auf dem Host nicht verfügbar");
    status = 404;
    fireEvent.click(screen.getByRole("button", { name: "Terminal starten" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("veraltet"));
  });

  it("hints how to sign in when the CLI is signed out and flags a missing auth endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("_cli-auth") ? fail(404) : { ok: true, json: async () => url.endsWith("_hostd") ? hostd({ version: "0.2.0" }) : { terminals: [] } }));
    render(<TerminalPage host="laptop" />);
    expect(await screen.findByText(/Anmeldestatus nicht abrufbar/)).toBeInTheDocument();
    expect(screen.getByText(/Host-Dienst 0\.2\.0 ist veraltet/)).toBeInTheDocument();
    cleanup();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith("_hostd") ? hostd() : url.endsWith("_cli-auth") ? { available: true, reason: null, clis: [{ id: "codex", state: "signed_out", method: null, checked_at: "x", reason: null }] } : { terminals: [] } })));
    render(<TerminalPage host="laptop" />);
    expect(await screen.findByText(/mit codex login/)).toBeInTheDocument();
  });

  it("lists running terminals with Laufzeit and lets the user reattach to another one and close with confirmation", async () => {
    const list = [{ ...terminal, id: "t1", created_at: new Date(Date.now() - 125_000).toISOString() }, { ...terminal, id: "t2", workspace: "repo", created_at: new Date().toISOString() }];
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, opts?: RequestInit) => { calls.push(`${opts?.method ?? "GET"} ${url}`); return { ok: true, json: async () => url.endsWith("_hostd") ? hostd() : { terminals: list } }; }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<TerminalPage host="laptop" />);
    expect(await screen.findByText(/Laufzeit 2:0\d min/)).toBeInTheDocument();
    await waitFor(() => expect(Socket.all).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Wieder verbinden" }));
    await waitFor(() => expect(Socket.all.some((s) => s.url.includes("/t2/stream"))).toBe(true));
    const close = screen.getAllByRole("button", { name: "Schließen" })[0];
    fireEvent.click(close);
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
    fireEvent.click(close);
    await waitFor(() => expect(calls.some((c) => c === "DELETE /bff/h/laptop/_terminals/t1")).toBe(true));
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});
