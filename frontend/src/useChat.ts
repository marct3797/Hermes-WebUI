import { useCallback, useEffect, useReducer, useRef } from "react";
import { api } from "./api";
import { chatReducer, historyItems, initialState } from "./chatReducer";
import { EVENT_NAMES, type Decision, type StreamEvent } from "./types";

const TERMINAL = new Set(["run.completed", "run.failed", "run.stopped", "stream.error"]);

type Opts = { profile: string; sessionId?: string; model?: string; onSession: (id: string) => void; onRunEnd: () => void };

/** Zustand und Run-Steuerung einer Chat-Ansicht (ein Profil, eine Session). */
export function useChat({ profile, sessionId, model, onSession, onRunEnd }: Opts) {
  const [state, dispatch] = useReducer(chatReducer, initialState);
  const source = useRef<EventSource | null>(null);
  const live = useRef<{ profile: string; sid?: string }>({ profile });
  const finished = useRef(false);
  // Session, die dieser Hook gerade selbst per Run angelegt hat: die URL-Änderung danach darf
  // weder den Stream kappen noch den Verlauf neu laden.
  const ownSession = useRef<string>();
  const cb = useRef({ onSession, onRunEnd });
  cb.current = { onSession, onRunEnd };

  const close = useCallback(() => { source.current?.close(); source.current = null; }, []);

  const attach = useCallback((runId: string, forProfile: string) => {
    close();
    finished.current = false;
    const es = new EventSource(api.eventsUrl(forProfile, runId));
    source.current = es;
    const handle = (ev: MessageEvent) => {
      let data: StreamEvent;
      try { data = JSON.parse(ev.data); } catch { return; }
      dispatch({ type: "event", event: data });
      if (TERMINAL.has(data.type)) {
        finished.current = true;
        es.close();
        cb.current.onRunEnd();
      }
    };
    for (const n of EVENT_NAMES) es.addEventListener(n, handle as EventListener);
    es.onerror = async () => {
      if (finished.current) return;
      es.close();
      try {
        const st = await api.runStatus(forProfile, runId);
        if (st.status && ["completed", "failed", "stopped"].includes(st.status)) {
          finished.current = true;
          cb.current.onRunEnd();
          if (live.current.sid) dispatch({ type: "history", items: historyItems(await api.messages(forProfile, live.current.sid)) });
          return;
        }
      } catch { /* Status nicht lesbar: als verloren melden */ }
      dispatch({ type: "connection-lost" });
    };
  }, [close]);

  // Session oder Profil gewechselt: Verlauf laden, laufende Verbindung kappen.
  useEffect(() => {
    if (!profile) return; // Profile sind noch nicht geladen
    live.current = { profile, sid: sessionId };
    if (sessionId && ownSession.current === sessionId) { ownSession.current = undefined; return; }
    close();
    if (!sessionId) { dispatch({ type: "reset" }); return; }
    let stale = false;
    api.messages(profile, sessionId)
      .then((m) => { if (!stale) dispatch({ type: "history", items: historyItems(m) }); })
      .catch((e: Error) => { if (!stale) dispatch({ type: "run-error", error: e.message }); });
    return () => { stale = true; };
  }, [profile, sessionId, close]);

  useEffect(() => close, [close]);

  const send = useCallback(async (text: string, images: string[]) => {
    dispatch({ type: "user-sent", text, images });
    try {
      const run = await api.startRun(profile, { text, session_id: live.current.sid, model, images: images.length ? images : undefined });
      if (run.session_id && run.session_id !== live.current.sid) {
        live.current.sid = run.session_id;
        ownSession.current = run.session_id;
        cb.current.onSession(run.session_id);
      }
      dispatch({ type: "run-accepted", runId: run.run_id });
      attach(run.run_id, profile);
    } catch (e) {
      dispatch({ type: "run-error", error: (e as Error).message });
    }
  }, [profile, model, attach]);

  const stop = useCallback(async () => {
    if (state.runId) await api.stop(profile, state.runId).catch(() => undefined);
  }, [profile, state.runId]);

  const decide = useCallback(async (itemId: string, decision: Decision, approvalId?: string) => {
    if (!state.runId) return;
    dispatch({ type: "decided", id: itemId, decision });
    await api.approve(profile, state.runId, decision, approvalId).catch((e: Error) => dispatch({ type: "run-error", error: e.message }));
  }, [profile, state.runId]);

  const answer = useCallback(async (itemId: string, text: string, clarifyId?: string) => {
    if (!state.runId) return;
    dispatch({ type: "answered", id: itemId, answer: text });
    await api.clarify(profile, state.runId, text, clarifyId).catch((e: Error) => dispatch({ type: "run-error", error: e.message }));
  }, [profile, state.runId]);

  const reconnect = useCallback(() => { if (state.runId) attach(state.runId, profile); }, [state.runId, profile, attach]);

  return { state, send, stop, decide, answer, reconnect };
}
