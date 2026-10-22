import { useEffect, useMemo, useRef, useState } from "react";
import { api, toLogin } from "../api";
import { Icon } from "../components/Icon";
import { AgentCard, UserMessage, groupTurns, runLabelOf } from "../components/chat/Convo";
import { Dock } from "../components/chat/Dock";
import { Inspector } from "../components/chat/Inspector";
import { STATUS_LABEL } from "../components/Status";
import { fmtClock, fmtCount } from "../format";
import { isEditable } from "../keys";
import { agentPath, navigate } from "../router";
import { useShell } from "../shell";
import type { AgentRef, AgentStatus, Decision, Item, SendMode } from "../types";
import { sigilFor, useUi } from "../ui";
import { useChat } from "../useChat";
import { useNow } from "../useNow";

type Props = { agent: AgentRef; label: string; runtimeLabel: string; sessionId?: string };

function modelIds(payload: unknown): string[] {
  const list = (payload as { models?: unknown[] } | null)?.models ?? (Array.isArray(payload) ? payload : []);
  return list.map((m) => (typeof m === "string" ? m : String((m as { id?: unknown }).id ?? ""))).filter(Boolean);
}
const currentModel = (payload: unknown): string | undefined => {
  const c = (payload as { current?: unknown } | null)?.current;
  return typeof c === "string" && c ? c : undefined;
};

const OFFLINE_HINT: Record<string, string> = {
  auth_error: "Der Zugangsschlüssel für diesen Host wurde abgelehnt oder fehlt im BFF.",
  gone: "Dieses Profil gibt es nicht mehr. Wähle links einen anderen Agent.",
  unsupported: "Dieser Agent bietet die benötigte API nicht an (ältere Version?).",
  unreachable: "Der Agent ist nicht erreichbar.",
};

const RUN_LABEL = { idle: "bereit", starting: "startet …", running: "arbeitet …", done: "fertig", failed: "fehlgeschlagen", stopped: "gestoppt", lost: "getrennt" } as const;
type Approval = Extract<Item, { kind: "approval" }>;

export function ChatPage({ agent, label, runtimeLabel, sessionId }: Props) {
  const { refreshSessions, sessions, openMenu } = useShell();
  const { sigils } = useUi();
  const [status, setStatus] = useState<AgentStatus>();
  const [models, setModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<string>();
  const [model, setModel] = useState<string>();
  const [selTool, setSelTool] = useState<string>();
  const [openTool, setOpenTool] = useState<string>();

  // Capability-Probe und Modelle je Agent. Das UI blendet aus, was der Agent nicht kann.
  useEffect(() => {
    let stale = false;
    setStatus(undefined);
    setModels([]);
    setModel(undefined);
    setDefaultModel(undefined);
    api.status(agent)
      .then((s) => {
        if (stale) return;
        setStatus(s);
        if (s.online) api.models(agent).then((m) => { if (!stale) { setModels(modelIds(m)); setDefaultModel(currentModel(m)); } }).catch(() => undefined);
      })
      .catch((e: Error) => { if (!stale) setStatus({ state: "unreachable", online: false, version: null, features: [], error: e.message }); });
    return () => { stale = true; };
  }, [agent]);

  const chat = useChat({
    agent, sessionId, model,
    onSession: (id) => { navigate(agentPath(agent, "chat", id), true); refreshSessions(); },
  });
  const { state } = chat;
  const busy = state.runStatus === "starting" || state.runStatus === "running";
  const online = status?.online ?? false;
  const canSend = status === undefined ? false : online;
  const canSteer = status?.features.includes("steer") ?? false;

  const pending = useMemo(
    () => [...state.items].reverse().find((i): i is Approval => i.kind === "approval" && !i.decision),
    [state.items],
  );
  const asking = state.items.some((i) => i.kind === "clarify" && !i.answer);
  const waiting = busy && (!!pending || asking);

  // Tastatur für die offene Freigabe: Enter einmal, S Session, Umschalt+A immer, Esc ablehnen.
  useEffect(() => {
    if (!pending || !busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isEditable(e.target)) return;
      let d: Decision | undefined;
      if (e.key === "Enter" && !e.shiftKey && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLAnchorElement)) d = "once";
      else if (e.key === "s" && !e.shiftKey) d = "session";
      else if (e.key === "A" && e.shiftKey) d = "always";
      else if (e.key === "Escape") d = "deny";
      if (d && pending.choices.includes(d)) { e.preventDefault(); void chat.decide(pending.id, d); }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [pending, busy, chat]);

  // Automatisch mitscrollen, solange die Person nicht selbst nach oben gescrollt hat.
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = log.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.items, state.runStatus]);

  const now = useNow(state.runStatus === "running");
  // Solange die Liste die neue Session noch nicht kennt, steht die erste Nachricht als Titel da.
  const firstUser = state.items.find((i) => i.kind === "message" && i.role === "user");
  const title = sessions.find((s) => s.id === sessionId)?.title
    ?? (firstUser?.kind === "message" ? firstUser.text.split("\n")[0].slice(0, 80) : "Neuer Chat");
  const tokens = state.usage ? (state.usage.total_tokens ?? (state.usage.input_tokens ?? 0) + (state.usage.output_tokens ?? 0)) : undefined;
  const tools = state.items.filter((i): i is Extract<Item, { kind: "tool" }> => i.kind === "tool");
  const subagents = state.items.filter((i): i is Extract<Item, { kind: "subagent" }> => i.kind === "subagent");
  const turns = groupTurns(state.items);
  const lastAgentTurn = turns.map((t) => t.kind).lastIndexOf("agent");

  const pickTool = (id: string) => {
    if (selTool === id) setOpenTool(openTool === id ? undefined : id);
    else { setSelTool(id); setOpenTool(id); }
  };
  const send = (text: string, images: string[], mode?: SendMode) => {
    if (!busy) void chat.send(text, images);
    else if (mode === "steer") void chat.steer(text);
    else chat.enqueue(text, images);
  };

  const runTag = !status ? null
    : !status.online ? <span className="tag tag-e">{(STATUS_LABEL[status.state] ?? status.state).toUpperCase()}</span>
    : waiting ? <span className="tag tag-s"><i className="dot dot-wait" />{pending ? "WARTET AUF FREIGABE" : "WARTET AUF ANTWORT"}</span>
    : state.runStatus === "running" || state.runStatus === "starting"
      ? <span className="tag tag-c"><i className="dot dot-run" />LÄUFT{state.startedAt ? ` · ${fmtClock((now - state.startedAt) / 1000)}` : ""}</span>
    : state.runStatus === "failed" ? <span className="tag tag-e">FEHLER</span>
    : state.runStatus === "lost" ? <span className="tag tag-e">GETRENNT</span>
    : state.runStatus === "stopped" ? <span className="tag">GESTOPPT</span>
    : null;

  return (
    <>
      <section className="cmain">
        <header className="chead">
          <button type="button" className="btn btn-s btn-i btn-g menu-btn" aria-label="Menü" onClick={openMenu}><Icon name="menu" size={18} /></button>
          <div className="col grow" style={{ gap: 3, minWidth: 0 }}>
            <nav className="crumb" style={{ fontSize: 11 }} aria-label="Pfad">
              <span>{agent.host}</span><Icon name="chevr" size={12} /><span>{agent.runtime}</span><Icon name="chevr" size={12} /><span>{agent.agent}</span>
              {sessionId && <><Icon name="chevr" size={12} /><b>chat/{sessionId.slice(0, 8)}</b></>}
            </nav>
            <h1 className="trunc">{title}</h1>
          </div>
          {status?.online && <span className="tag">{runtimeLabel}{status.version ? ` ${status.version}` : ""}</span>}
          {runTag}
        </header>

        {status && !status.online && (
          <p className="banner" role="alert" style={{ margin: "12px 24px 0" }}>
            <Icon name="alert" />
            <span>{label}: {OFFLINE_HINT[status.state] ?? "Nicht verfügbar."}{status.error ? ` (${status.error})` : ""}</span>
          </p>
        )}

        <div className="convo-scroll" role="log" aria-live="polite" ref={log}
          onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
          <div className="convo">
            {state.items.length === 0 && state.runStatus === "idle" && (
              <div className="empty">
                <h2>Wie kann {label} helfen?</h2>
                <p className="muted mono small">{agent.host} · {agent.runtime}</p>
              </div>
            )}
            {turns.map((t, i) => t.kind === "user"
              ? <UserMessage key={t.item.id} m={t.item} />
              : <AgentCard key={t.items[0].id} items={t.items} name={label} sigil={sigilFor(sigils, agent)} model={model ?? defaultModel}
                  runLabel={i === lastAgentTurn ? runLabelOf(state.runId) : undefined} live={i === lastAgentTurn && busy} busy={busy}
                  selTool={selTool} openTool={openTool} onPickTool={pickTool}
                  onDecide={(id, d) => void chat.decide(id, d)} onAnswer={(id, a, cid) => void chat.answer(id, a, cid)} />)}
            {state.error && (
              <p className="banner" role="alert">
                <Icon name="alert" />
                <span className="grow">{state.error}</span>
                {state.errorCode === "step_up_required" && <button type="button" className="btn btn-s btn-p" onClick={() => toLogin(true)}>Erneut anmelden</button>}
                {state.runStatus === "lost" && state.runId && <button type="button" className="btn btn-s" onClick={chat.reconnect}>Erneut verbinden</button>}
              </p>
            )}
          </div>
        </div>

        <div className="dockwrap">
          <Dock busy={busy} disabled={!canSend} name={label} models={models} model={model ?? ""} defaultModel={defaultModel} onModel={setModel}
            canSteer={canSteer} queued={state.queued} onSend={send} onStop={() => void chat.stop()}
            onSendQueued={chat.sendQueued} onDropQueued={chat.dropQueued} />
          <div className="dockw"><div className="tkrail" aria-label="Status">
            {tokens != null && <span className="cnt"><Icon name="layers" size={12} /><b>{fmtCount(tokens)}</b> tok</span>}
            <span>{RUN_LABEL[state.runStatus]}</span>
            {busy && <span className="r cnt"><i className="dot dot-run" />Live</span>}
          </div></div>
        </div>
      </section>
      <Inspector tools={tools} subagents={subagents} selected={selTool} onSelect={(id) => { setSelTool(id); setOpenTool(undefined); }} />
    </>
  );
}
