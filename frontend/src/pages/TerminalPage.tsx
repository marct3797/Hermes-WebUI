import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "../styles/workspace.css";

type Terminal = { id: string; cli: string; workspace: string; running: boolean; pid: number; created_at: number; exit_code?: number };
type Info = { available?: boolean; reason?: string; clis: { id: string; label: string; available: boolean; authenticated?: boolean | null; auth_note?: string }[]; workspaces: { id: string; label: string }[] };
async function request<T>(url: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { method, credentials: "same-origin", signal,
    headers: { "X-Requested-With": "hermes-webui", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`Terminal-Anfrage fehlgeschlagen (${response.status}); ggf. frisch anmelden.`);
  return response.json();
}
const MOBILE_KEYS = [["Esc", "\x1b"], ["Tab", "\t"], ["Ctrl+C", "\x03"], ["Ctrl+D", "\x04"], ["↑", "\x1b[A"], ["↓", "\x1b[B"], ["←", "\x1b[D"], ["→", "\x1b[C"], ["Enter", "\r"]];
const encodeInput = (data: string) => btoa(Array.from(new TextEncoder().encode(data), (byte) => String.fromCharCode(byte)).join(""));

export function TerminalPage({ host }: { host: string }) {
  const base = `/bff/h/${encodeURIComponent(host)}`;
  const [info, setInfo] = useState<Info>();
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [selected, setSelected] = useState("");
  const [cli, setCli] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [error, setError] = useState<string>();
  const [gap, setGap] = useState<string>();
  const [connection, setConnection] = useState("Nicht verbunden");
  const [busy, setBusy] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const socket = useRef<WebSocket>();
  const terminalRef = useRef<XTerm>();
  const reconnect = useRef<() => void>(() => {});
  const noticeOptIn = useRef(false);
  const current = terminals.find((t) => t.id === selected);

  useEffect(() => {
    const controller = new AbortController();
    setInfo(undefined); setTerminals([]); setSelected(""); setError(undefined);
    try { noticeOptIn.current = sessionStorage.getItem("hermes-terminal-notifications") === "true"; setNotifications(noticeOptIn.current); } catch { /* private mode */ }
    request<Info>(`${base}/_hostd`, "GET", undefined, controller.signal).then(async (data) => {
      if (controller.signal.aborted) return;
      setInfo(data); setCli(data.clis?.find((c) => c.available)?.id ?? ""); setWorkspace(data.workspaces?.[0]?.id ?? "");
      if (data.available === false) return;
      const list = await request<{ terminals: Terminal[] }>(`${base}/_terminals`, "GET", undefined, controller.signal);
      if (controller.signal.aborted) return;
      setTerminals(list.terminals);
      let saved: string | null = null;
      try { saved = sessionStorage.getItem(`hermes-terminal:${host}`); } catch { /* private mode */ }
      setSelected(list.terminals.find((t) => t.id === saved)?.id ?? list.terminals[0]?.id ?? "");
    }).catch((e: Error) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [base, host]);

  useEffect(() => {
    if (!selected || !container.current) return;
    let disposed = false, offset = 0, retry = 0, wasRunning = current?.running ?? false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { sessionStorage.setItem(`hermes-terminal:${host}`, selected); } catch { /* private mode */ }
    const term = new XTerm({ cursorBlink: true, fontFamily: getComputedStyle(container.current).getPropertyValue("--mono").trim() || "monospace", fontSize: 13, scrollback: 3000, allowProposedApi: false });
    const fit = new FitAddon();
    term.loadAddon(fit); term.open(container.current); terminalRef.current = term;
    const send = (frame: unknown) => { if (socket.current?.readyState === 1) socket.current.send(JSON.stringify(frame)); };
    const resize = () => {
      try { fit.fit(); send({ type: "resize", cols: term.cols, rows: term.rows }); } catch { /* hidden viewport */ }
    };
    const input = term.onData((data) => send({ type: "input", data: encodeInput(data) }));
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : undefined;
    observer?.observe(container.current); window.addEventListener("resize", resize);
    const connect = () => {
      if (disposed) return;
      clearTimeout(timer);
      const previous = socket.current;
      if (previous) { previous.onclose = null; previous.close(); }
      setConnection("Verbinde…");
      const url = new URL(`${base}/_terminals/${encodeURIComponent(selected)}/stream?after=${offset}`, location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(url.toString()); socket.current = ws;
      ws.onopen = () => { if (disposed || socket.current !== ws) return; retry = 0; setConnection("Verbunden"); setError(undefined); resize(); term.focus(); };
      ws.onmessage = (event) => {
        if (disposed || socket.current !== ws) return;
        try {
          const frame = JSON.parse(event.data);
          if (frame.type === "gap") {
            if (Number.isSafeInteger(frame.available_from) && frame.available_from >= 0) offset = frame.available_from;
            setGap("Ältere Terminal-Ausgabe ist nicht mehr im Replay-Puffer verfügbar.");
          } else if (frame.type === "output") {
            if (typeof frame.data !== "string" || frame.data.length > 524288 || !Number.isSafeInteger(frame.offset) || frame.offset < 0) throw new Error("Ungültige Terminal-Ausgabe");
            const bytes = Uint8Array.from(atob(frame.data), (char) => char.charCodeAt(0));
            if (frame.offset > offset) setGap("Terminal-Ausgabe unvollständig: Replay-Lücke.");
            const skip = Math.max(0, offset - frame.offset);
            if (skip < bytes.length) term.write(bytes.slice(skip));
            offset = Math.max(offset, frame.offset + bytes.length);
          } else if (frame.type === "state" && frame.terminal?.id === selected) {
            const ended: Terminal = frame.terminal;
            setTerminals((all) => all.map((t) => t.id === selected ? ended : t));
            term.options.disableStdin = !ended.running;
            if (wasRunning && !ended.running && noticeOptIn.current && typeof Notification !== "undefined" && Notification.permission === "granted") {
              try { new Notification("Terminal beendet", { body: `${host} · ${ended.cli}` }); } catch { /* unsupported platform */ }
            }
            wasRunning = ended.running;
          }
        } catch { setError("Terminal-Ereignis konnte nicht gelesen werden."); }
      };
      ws.onerror = () => { if (!disposed) setError("Terminal-Verbindung unterbrochen. Erneute Anmeldung kann erforderlich sein."); };
      ws.onclose = () => {
        if (disposed || socket.current !== ws) return;
        setConnection(wasRunning ? "Verbindung unterbrochen" : "Beendet");
        if (wasRunning) timer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 10000));
      };
    };
    reconnect.current = connect; connect(); resize();
    return () => {
      disposed = true; clearTimeout(timer); observer?.disconnect(); window.removeEventListener("resize", resize);
      socket.current?.close(); socket.current = undefined; input.dispose(); term.dispose(); terminalRef.current = undefined;
      reconnect.current = () => {};
    };
    // The PTY and replay cursor live across socket reconnects, not across terminal selections.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, selected, host]);

  const create = async () => {
    setBusy(true); setError(undefined);
    try {
      const term = await request<Terminal>(`${base}/_terminals`, "POST", { cli, workspace, cols: terminalRef.current?.cols ?? 80, rows: terminalRef.current?.rows ?? 24 });
      setTerminals((all) => [...all, term]); setSelected(term.id);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const stop = async () => {
    if (!selected || !window.confirm("Diesen Terminal-Prozess beenden?")) return;
    setBusy(true);
    try { await request(`${base}/_terminals/${encodeURIComponent(selected)}`, "DELETE"); const data = await request<{ terminals: Terminal[] }>(`${base}/_terminals`); setTerminals(data.terminals); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const toggleNotifications = async (checked: boolean) => {
    try {
      noticeOptIn.current = checked && typeof Notification !== "undefined" && (Notification.permission === "granted" || await Notification.requestPermission() === "granted");
      setNotifications(noticeOptIn.current);
      sessionStorage.setItem("hermes-terminal-notifications", String(noticeOptIn.current));
      if (checked && !noticeOptIn.current) setError("Benachrichtigungen sind nicht freigegeben.");
    } catch { setError("Benachrichtigungen sind nicht verfügbar."); }
  };

  return <main className="page terminal-page">
    <header className="workspace-toolbar"><div><h1>Terminal</h1><p className="muted">{host} · Bestehende CLI-Anmeldung auf diesem Host</p></div>
      <label><input type="checkbox" checked={notifications} onChange={(e) => void toggleNotifications(e.target.checked)} /> Abschluss melden (opt-in)</label>
    </header>
    {(error || gap) && <p className="banner" role="alert">{error ?? gap}</p>}
    {!info && !error && <p role="status">Lade Terminal-Konfiguration…</p>}
    {info?.available === false ? <p role="status">{info.reason ?? "Host-Dienst nicht eingerichtet."}</p> : info && <>
      <div className="workspace-toolbar">
        <label>CLI <select className="field" value={cli} onChange={(e) => setCli(e.target.value)}><option value="" disabled>CLI wählen</option>{info.clis?.map((c) => <option value={c.id} key={c.id} disabled={!c.available}>{c.label}{!c.available ? " · nicht verfügbar" : ""}</option>)}</select></label>
        <label>Arbeitsordner <select className="field" value={workspace} onChange={(e) => setWorkspace(e.target.value)}><option value="" disabled>Arbeitsordner wählen</option>{info.workspaces?.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}</select></label>
        <button className="btn btn-s" disabled={busy || !cli || !workspace} onClick={() => void create()}>Terminal starten</button>
      </div>
      <p className="muted">Installation ist kein Anmeldenachweis. {info.clis?.find((c) => c.id === cli)?.auth_note ?? "Anmeldestatus unbekannt; Anmeldung bleibt in der CLI."}</p>
      {terminals.length ? <label>Terminal auswählen <select className="field" value={selected} onChange={(e) => { setGap(undefined); setSelected(e.target.value); }}>{terminals.map((t) => <option value={t.id} key={t.id}>{t.cli} · {t.workspace} · {t.running ? "läuft" : "beendet"} · {t.id}</option>)}</select></label> : <p role="status">Keine Terminals. Ein Start führt die konfigurierte CLI aus.</p>}
    </>}
    <div ref={container} className="terminal-viewport" aria-label="CLI Terminal" hidden={!selected} />
    {selected && <><div className="workspace-toolbar"><p role="status">{connection}{current && !current.running ? ` · Exit ${current.exit_code ?? "unbekannt"}` : ""}</p><button className="btn btn-s btn-g" onClick={() => reconnect.current()}>Neu verbinden</button><button className="btn btn-s btn-g" disabled={busy || !current?.running} onClick={() => void stop()}>Prozess beenden</button></div>
      <div className="terminal-keys" aria-label="Mobile CLI-Tasten">{MOBILE_KEYS.map(([label, key]) => <button className="btn btn-s" key={label} disabled={!current?.running || connection !== "Verbunden"} onClick={() => { if (socket.current?.readyState === 1) socket.current.send(JSON.stringify({ type: "input", data: encodeInput(key) })); terminalRef.current?.focus(); }}>{label}</button>)}</div>
      <p className="muted small">Navigation und Verbindungsabbruch beenden den Prozess nicht. Ausgabe wird nur begrenzt wiederholt.</p></>}
  </main>;
}
