import { useEffect, useRef, useState } from "react";
import { api, toLogin } from "../api";
import { Composer } from "../components/Composer";
import { ApprovalCard, ClarifyCard, MessageView, ToolCard } from "../components/Items";
import { PageHeader } from "../components/PageHeader";
import { STATUS_LABEL } from "../components/Status";
import { agentPath, navigate } from "../router";
import { useShell } from "../shell";
import type { AgentRef, AgentStatus } from "../types";
import { useChat } from "../useChat";

type Props = { agent: AgentRef; label: string; runtimeLabel: string; sessionId?: string };

function modelIds(payload: unknown): string[] {
  const list = (payload as { models?: unknown[] } | null)?.models ?? (Array.isArray(payload) ? payload : []);
  return list.map((m) => (typeof m === "string" ? m : String((m as { id?: unknown }).id ?? ""))).filter(Boolean);
}

const OFFLINE_HINT: Record<string, string> = {
  auth_error: "Der Zugangsschlüssel für diesen Host wurde abgelehnt oder fehlt im BFF.",
  gone: "Dieses Profil gibt es nicht mehr. Wähle links einen anderen Agent.",
  unsupported: "Dieser Agent bietet die benötigte API nicht an (ältere Version?).",
  unreachable: "Der Agent ist nicht erreichbar.",
};

const RUN_LABEL = { idle: "bereit", starting: "startet…", running: "arbeitet…", done: "fertig", failed: "fehlgeschlagen", stopped: "gestoppt", lost: "getrennt" } as const;

export function ChatPage({ agent, label, runtimeLabel, sessionId }: Props) {
  const { refreshSessions, sessions } = useShell();
  const [status, setStatus] = useState<AgentStatus>();
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState<string>();

  // Capability-Probe und Modelle je Agent. Das UI blendet aus, was der Agent nicht kann.
  useEffect(() => {
    let stale = false;
    setStatus(undefined);
    setModels([]);
    setModel(undefined);
    api.status(agent)
      .then((s) => {
        if (stale) return;
        setStatus(s);
        if (s.online) api.models(agent).then((m) => { if (!stale) setModels(modelIds(m)); }).catch(() => undefined);
      })
      .catch((e: Error) => { if (!stale) setStatus({ state: "unreachable", online: false, version: null, features: [], error: e.message }); });
    return () => { stale = true; };
  }, [agent]);

  const chat = useChat({
    agent, sessionId, model,
    onSession: (id) => navigate(agentPath(agent, "chat", id), true),
    onRunEnd: refreshSessions,
  });
  const { state } = chat;
  const busy = state.runStatus === "starting" || state.runStatus === "running";
  const online = status?.online ?? false;
  const canSend = status === undefined ? false : online;

  // Automatisch mitscrollen, solange die Person nicht selbst nach oben gescrollt hat.
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = log.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.items, state.runStatus]);

  const title = sessions.find((s) => s.id === sessionId)?.title ?? "Neuer Chat";
  const tokens = state.usage ? (state.usage.total_tokens ?? (state.usage.input_tokens ?? 0) + (state.usage.output_tokens ?? 0)) : undefined;
  const pillState = status ? (status.online ? "online" : status.state) : "unknown";

  return (
    <main className="chat">
      <PageHeader title={title}>
        {models.length > 0 && (
          <select value={model ?? ""} onChange={(e) => setModel(e.target.value || undefined)} aria-label="Modell">
            <option value="">Standardmodell</option>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
        <span className={`pill ${pillState}`} role="status">
          <span className="dot" aria-hidden />
          {status === undefined ? "prüfe…" : status.online ? `${runtimeLabel}${status.version ? ` ${status.version}` : ""}` : STATUS_LABEL[status.state] ?? status.state}
        </span>
      </PageHeader>

      {status && !status.online && (
        <p className="banner error" role="alert">
          {label}: {OFFLINE_HINT[status.state] ?? "Nicht verfügbar."}{status.error ? ` (${status.error})` : ""}
        </p>
      )}

      <div className="log" role="log" aria-live="polite" ref={log}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        <div className="thread">
          {state.items.length === 0 && state.runStatus === "idle" && (
            <div className="empty"><h2>Wie kann {label} helfen?</h2><p className="muted mono small">{agent.host} · {agent.runtime}</p></div>
          )}
          {state.items.map((i) => {
            switch (i.kind) {
              case "message": return <MessageView key={i.id} m={i} name={label} />;
              case "tool": return <ToolCard key={i.id} t={i} />;
              case "approval": return <ApprovalCard key={i.id} a={i} disabled={!busy} onDecide={(d) => chat.decide(i.id, d)} />;
              case "clarify": return <ClarifyCard key={i.id} c={i} onAnswer={(a) => chat.answer(i.id, a, i.clarifyId)} />;
            }
          })}
          {state.error && (
            <p className="banner error" role="alert">
              <span>{state.error}</span>
              {state.errorCode === "step_up_required" && <button type="button" className="primary small" onClick={() => toLogin(true)}>Erneut anmelden</button>}
              {state.runStatus === "lost" && state.runId && <button type="button" className="ghost small" onClick={chat.reconnect}>Erneut verbinden</button>}
            </p>
          )}
        </div>
      </div>

      <footer className="dock">
        <Composer busy={busy} disabled={!canSend} name={label} onSend={chat.send} onStop={chat.stop} />
        <div className="rail mono" aria-label="Status">
          <span>{RUN_LABEL[state.runStatus]}</span>
          {tokens != null && <span>{tokens.toLocaleString("de-DE")} Tokens</span>}
          <span>{agent.host}/{agent.agent}</span>
        </div>
      </footer>
    </main>
  );
}
