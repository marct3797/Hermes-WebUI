import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TerminalPage } from "./TerminalPage";

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
    setup(false); render(<TerminalPage host="hikari" />);
    expect(await screen.findByText("Nicht eingerichtet")).toBeInTheDocument();
    expect(Socket.all).toHaveLength(0);
  });
});
