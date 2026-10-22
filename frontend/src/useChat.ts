import { useCallback, useEffect, useReducer, useRef } from "react";
import { ApiError, api } from "./api";
import { chatReducer, historyItems, initialState } from "./chatReducer";
import { TERMINAL_EVENTS, type AgentRef, type Decision, type StreamEvent } from "./types";

type Opts = { agent?: AgentRef; sessionId?: string; model?: string; onSession: (id: string) => void; onRunEnd: () => void };

/**
 * Zustand und Run-Steuerung einer Chat-Ansicht (ein Agent, eine Session).
 * `agent` muss über Renders hinweg dasselbe Objekt sein (siehe useAgentRef), sonst lädt der Verlauf ständig neu.
 */
export function useChat({ agent, sessionId, model, onSession, onRunEnd }: Opts) {
  const [state, dispatch] = useReducer(chatReducer, initialState);
  const source = useRef<EventSource | null>(null);
  const live = useRef<{ agent?: AgentRef; sid?: string }>({ agent });
  const finished = useRef(false);
  // Session, die dieser Hook gerade selbst per Run angelegt hat: die URL-Änderung danach darf
  // weder den Stream kappen noch den Verlauf neu laden.
  const ownSession = useRef<string>();
  const cb = useRef({ onSession, onRunEnd });
  cb.current = { onSession, onRunEnd };

  const close = useCallback(() => { source.current?.close(); source.current = null; }, []);

  const attach = useCallback((runId: string, forAgent: AgentRef) => {
    close();
    finished.current = false;
    const es = new EventSource(api.eventsUrl(forAgent, runId));
    source.current = es;
    // Das BFF sendet unbenannte Frames; der Typ steckt im JSON.
    es.onmessage = (ev: MessageEvent) => {
      let data: StreamEvent;
      try { data = JSON.parse(ev.data); } catch { return; }
      dispatch({ type: "event", event: data });
      if (TERMINAL_EVENTS.has(data.type)) {
        finished.current = true;
        es.close();
        cb.current.onRunEnd();
      }
    };
    es.onerror = async () => {
      if (finished.current) return;
      es.close();
      try {
        const st = await api.runStatus(forAgent, runId);
        if (st.status && ["completed", "failed", "stopped"].includes(st.status)) {
          finished.current = true;
          cb.current.onRunEnd();
          if (live.current.sid) dispatch({ type: "history", items: historyItems(await api.messages(forAgent, live.current.sid)) });
          return;
        }
      } catch { /* Status nicht lesbar: als verloren melden */ }
      dispatch({ type: "connection-lost" });
    };
  }, [close]);

  // Session oder Agent gewechselt: Verlauf laden, laufende Verbindung kappen.
  useEffect(() => {
    if (!agent) return; // Hosts sind noch nicht geladen
    live.current = { agent, sid: sessionId };
    if (sessionId && ownSession.current === sessionId) { ownSession.current = undefined; return; }
    close();
    if (!sessionId) { dispatch({ type: "reset" }); return; }
    let stale = false;
    api.messages(agent, sessionId)
      .then((m) => { if (!stale) dispatch({ type: "history", items: historyItems(m) }); })
      .catch((e: Error) => { if (!stale) dispatch({ type: "run-error", error: e.message }); });
    return () => { stale = true; };
  }, [agent, sessionId, close]);

  useEffect(() => close, [close]);

  const send = useCallback(async (text: string, images: string[]) => {
    if (!agent) return;
    dispatch({ type: "user-sent", text, images });
    try {
      const run = await api.startRun(agent, { text, session_id: live.current.sid, model, images: images.length ? images : undefined });
      if (run.session_id && run.session_id !== live.current.sid) {
        live.current.sid = run.session_id;
        ownSession.current = run.session_id;
        cb.current.onSession(run.session_id);
      }
      dispatch({ type: "run-accepted", runId: run.run_id });
      attach(run.run_id, agent);
    } catch (e) {
      dispatch({ type: "run-error", error: (e as Error).message });
    }
  }, [agent, model, attach]);

  const stop = useCallback(async () => {
    if (agent && state.runId) await api.stop(agent, state.runId).catch(() => undefined);
  }, [agent, state.runId]);

  const decide = useCallback(async (itemId: string, decision: Decision) => {
    if (!agent || !state.runId) return;
    dispatch({ type: "decided", id: itemId, decision });
    try {
      await api.approve(agent, state.runId, decision);
    } catch (e) {
      // Karte wieder freigeben, damit die Person es erneut versuchen kann (z. B. nach neuer Anmeldung).
      dispatch({ type: "decision-failed", id: itemId });
      dispatch({ type: "notice", error: (e as Error).message, code: e instanceof ApiError ? e.code : undefined });
    }
  }, [agent, state.runId]);

  const answer = useCallback(async (itemId: string, text: string, clarifyId?: string) => {
    if (!agent || !state.runId) return;
    dispatch({ type: "answered", id: itemId, answer: text });
    await api.clarify(agent, state.runId, text, clarifyId).catch((e: Error) => dispatch({ type: "notice", error: e.message }));
  }, [agent, state.runId]);

  const reconnect = useCallback(() => { if (agent && state.runId) attach(state.runId, agent); }, [agent, state.runId, attach]);

  return { state, send, stop, decide, answer, reconnect };
}
