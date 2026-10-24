import { useCallback, useEffect } from "react";
import type { Reasoning } from "./composerLogic";
import { initialState } from "./chatReducer";
import { convKey } from "./runStore";
import { useRunSnapshot, useRunStore } from "./runs";
import type { AgentRef, Decision } from "./types";

type Opts = { agent?: AgentRef; sessionId?: string; model?: string; onSession: (id: string) => void };

/**
 * Ansicht einer Unterhaltung (ein Agent, eine Session). Der Zustand lebt im RunStore und bleibt beim
 * Seitenwechsel erhalten; Aktionen gehen an dieselbe Unterhaltung.
 * `agent` muss über Renders hinweg dasselbe Objekt sein (siehe useAgentRef).
 */
export function useChat({ agent, sessionId, model, onSession }: Opts) {
  const store = useRunStore();
  const snap = useRunSnapshot();
  const key = agent ? convKey(agent, sessionId) : undefined;
  const state = (key ? snap.convs.get(key)?.state : undefined) ?? initialState;
  /** Aufwand der letzten Anfrage dieser Unterhaltung (für die Beschriftung an der Antwort). */
  const reasoning = key ? snap.convs.get(key)?.reasoning : undefined;

  // Session oder Agent gewechselt: Verlauf laden, falls diese Unterhaltung noch unbekannt ist.
  useEffect(() => {
    if (agent) store.open(agent, sessionId);
  }, [store, agent, sessionId]);

  const send = useCallback(async (text: string, images: string[], reasoning?: Reasoning) => {
    if (agent) await store.send(agent, sessionId, text, images, { model, reasoning, onSession });
  }, [store, agent, sessionId, model, onSession]);

  const steer = useCallback(async (text: string) => { if (key) await store.steer(key, text); }, [store, key]);
  const enqueue = useCallback((text: string, images: string[], reasoning?: Reasoning) => { if (key) store.enqueue(key, text, images, reasoning); }, [store, key]);
  const dropQueued = useCallback((id: string) => { if (key) store.dropQueued(key, id); }, [store, key]);
  const sendQueued = useCallback((id: string) => { if (key) store.sendQueued(key, id); }, [store, key]);
  const stop = useCallback(async () => { if (key) await store.stop(key); }, [store, key]);
  const decide = useCallback(async (itemId: string, d: Decision) => { if (key) await store.decide(key, itemId, d); }, [store, key]);
  const answer = useCallback(async (itemId: string, text: string, clarifyId?: string) => { if (key) await store.answer(key, itemId, text, clarifyId); }, [store, key]);
  const reconnect = useCallback(() => { if (key) store.reconnect(key); }, [store, key]);
  const continueInFork = useCallback(() => { if (key) void store.continueInFork(key, onSession); }, [store, key, onSession]);

  return { state, reasoning, send, steer, enqueue, dropQueued, sendQueued, stop, decide, answer, reconnect, continueInFork };
}
