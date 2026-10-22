import { ApiError, api as realApi } from "./api";
import { chatReducer, historyItems, initialState, type Action } from "./chatReducer";
import { agentKey } from "./router";
import { TERMINAL_EVENTS, type AgentRef, type ChatState, type Decision, type StreamEvent } from "./types";

/**
 * Alle Unterhaltungen dieser WebUI mit ihrem Run-Zustand, unabhängig davon, welche Seite gerade offen ist.
 * Ein Run läuft weiter, wenn man zum Cockpit wechselt; Cockpit, Inbox und Seitenleiste lesen denselben Zustand.
 * Sichtbar sind nur Runs, die diese WebUI selbst gestartet hat (Runs aus CLI oder Cron kennt Hermes' API nicht als Liste).
 */

export const NEW = "new";
export const convKey = (a: AgentRef, sessionId?: string) => `${agentKey(a)}#${sessionId ?? NEW}`;

export type Conv = {
  key: string;
  agent: AgentRef;
  sessionId?: string;
  state: ChatState;
  /** Modell der letzten Auswahl; vorgemerkte Nachrichten gehen damit los. */
  model?: string;
  /** Verlauf konnte nicht geladen werden: beim nächsten Öffnen erneut versuchen. */
  stale?: boolean;
  touched: number;
};

/** Eine erledigte Entscheidung (Inbox: „Erledigt heute“). */
export type LogEntry = { id: string; at: number; agent: AgentRef; text: string };

export type Snapshot = { convs: ReadonlyMap<string, Conv>; log: readonly LogEntry[]; dismissed: ReadonlySet<string> };

type Deps = { api: typeof realApi; eventSource: (url: string) => EventSource };
type SendOpts = { model?: string; onSession?: (sessionId: string) => void };
type Source = { es: EventSource; holder: { key: string }; finished: boolean };

const MAX_CONVS = 40;
export const DECISION_DONE: Record<Decision, string> = {
  once: "einmal erlaubt", session: "für die Session erlaubt", always: "dauerhaft erlaubt", deny: "abgelehnt",
};

const live = (s: ChatState) => s.runStatus === "starting" || s.runStatus === "running";

export function createRunStore(deps: Deps = { api: realApi, eventSource: (u) => new EventSource(u) }) {
  const { api } = deps;
  let snap: Snapshot = { convs: new Map(), log: [], dismissed: new Set() };
  const listeners = new Set<() => void>();
  const endListeners = new Set<(agent: AgentRef) => void>();
  const sources = new Map<string, Source>();
  const loading = new Set<string>();

  const commit = (next: Partial<Snapshot>) => {
    snap = { ...snap, ...next };
    listeners.forEach((l) => l());
  };

  const putConv = (conv: Conv) => {
    const convs = new Map(snap.convs);
    convs.set(conv.key, conv);
    if (convs.size > MAX_CONVS) {
      // Älteste beendete Unterhaltungen verwerfen; laufende und wartende bleiben.
      const idle = [...convs.values()].filter((c) => !live(c.state) && c.key !== conv.key).sort((a, b) => a.touched - b.touched);
      for (const c of idle.slice(0, convs.size - MAX_CONVS)) convs.delete(c.key);
    }
    commit({ convs });
  };

  const dropConv = (key: string) => {
    if (!snap.convs.has(key)) return;
    const convs = new Map(snap.convs);
    convs.delete(key);
    commit({ convs });
  };

  const ensure = (agent: AgentRef, sessionId: string | undefined): Conv => {
    const key = convKey(agent, sessionId);
    const found = snap.convs.get(key);
    if (found) return found;
    const conv: Conv = { key, agent, sessionId, state: initialState, touched: Date.now() };
    putConv(conv);
    return conv;
  };

  const dispatch = (key: string, action: Action) => {
    const conv = snap.convs.get(key);
    if (!conv) return;
    putConv({ ...conv, state: chatReducer(conv.state, action), touched: Date.now() });
  };

  const patch = (key: string, p: Partial<Conv>) => {
    const conv = snap.convs.get(key);
    if (conv) putConv({ ...conv, ...p });
  };

  /** Neue Session bekommt ihre Kennung erst mit der Antwort auf den Run-Start: Unterhaltung und Stream ziehen um. */
  const rekey = (from: string, sessionId: string): string => {
    const conv = snap.convs.get(from);
    if (!conv) return from;
    const key = convKey(conv.agent, sessionId);
    if (key === from) return from;
    const convs = new Map(snap.convs);
    convs.delete(from);
    convs.set(key, { ...conv, key, sessionId });
    const src = sources.get(from);
    if (src) { sources.delete(from); src.holder.key = key; sources.set(key, src); }
    commit({ convs });
    return key;
  };

  const closeSource = (key: string) => {
    const src = sources.get(key);
    if (src) { src.finished = true; src.es.close(); sources.delete(key); }
  };

  const log = (entry: LogEntry) => commit({ log: [entry, ...snap.log].slice(0, 50) });

  const runEnded = (agent: AgentRef) => endListeners.forEach((l) => l(agent));

  function attach(key: string, runId: string) {
    closeSource(key);
    const conv = snap.convs.get(key);
    if (!conv) return;
    const src: Source = { es: deps.eventSource(api.eventsUrl(conv.agent, runId)), holder: { key }, finished: false };
    sources.set(key, src);
    const { es, holder } = src;
    // Das BFF sendet unbenannte Frames; der Typ steckt im JSON.
    es.onmessage = (ev: MessageEvent) => {
      let data: StreamEvent;
      try { data = JSON.parse(ev.data); } catch { return; }
      dispatch(holder.key, { type: "event", event: data });
      if (!TERMINAL_EVENTS.has(data.type)) return;
      src.finished = true;
      es.close();
      sources.delete(holder.key);
      const c = snap.convs.get(holder.key);
      runEnded(conv.agent);
      // Vorgemerkte Nachrichten gehen erst nach einem sauberen Ende los; nach Fehler oder Stopp entscheidet die Person.
      if (c && data.type === "run.completed" && c.state.queued.length > 0) sendQueued(holder.key, c.state.queued[0].id);
    };
    es.onerror = async () => {
      if (src.finished) return;
      es.close();
      const k = holder.key;
      try {
        const st = await api.runStatus(conv.agent, runId);
        if (st.status && ["completed", "failed", "stopped"].includes(st.status)) {
          src.finished = true;
          sources.delete(k);
          runEnded(conv.agent);
          const sid = snap.convs.get(k)?.sessionId;
          if (sid) dispatch(k, { type: "history", items: historyItems(await api.messages(conv.agent, sid)) });
          return;
        }
      } catch { /* Status nicht lesbar: als verloren melden */ }
      dispatch(holder.key, { type: "connection-lost" });
    };
  }

  async function send(agent: AgentRef, sessionId: string | undefined, text: string, images: string[], opts: SendOpts = {}) {
    let key = ensure(agent, sessionId).key;
    patch(key, { model: opts.model });
    dispatch(key, { type: "user-sent", text, images });
    try {
      const run = await api.startRun(agent, { text, session_id: sessionId, model: opts.model, images: images.length ? images : undefined });
      if (run.session_id && run.session_id !== sessionId) {
        key = rekey(key, run.session_id);
        opts.onSession?.(run.session_id);
      }
      dispatch(key, { type: "run-accepted", runId: run.run_id });
      attach(key, run.run_id);
    } catch (e) {
      dispatch(key, { type: "run-error", error: (e as Error).message });
    }
  }

  function sendQueued(key: string, id: string) {
    const conv = snap.convs.get(key);
    const item = conv?.state.queued.find((q) => q.id === id);
    if (!conv || !item) return;
    dispatch(key, { type: "queue-remove", id });
    void send(conv.agent, conv.sessionId, item.text, item.images, { model: conv.model });
  }

  return {
    subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    getSnapshot: () => snap,
    /** Ein Run dieses Agents ist zu Ende (für das Auffrischen der Session-Liste). */
    onRunEnd(cb: (agent: AgentRef) => void) { endListeners.add(cb); return () => { endListeners.delete(cb); }; },

    /**
     * Die Ansicht einer Unterhaltung wird geöffnet. Bekannte Unterhaltungen (auch beendete) bleiben, wie sie sind:
     * Der Verlauf vom Server kennt keine Tool-Zeilen oder Denkschritte. Unbekannte Sessions laden ihren Verlauf.
     */
    open(agent: AgentRef, sessionId?: string) {
      const key = convKey(agent, sessionId);
      const conv = snap.convs.get(key);
      if (!sessionId) {
        // Frischer Chat: Reste einer gescheiterten Anfrage verwerfen.
        if (conv && conv.state.runStatus !== "starting") dropConv(key);
        return;
      }
      if ((conv && !conv.stale) || loading.has(key)) return;
      loading.add(key);
      api.messages(agent, sessionId)
        .then((m) => {
          if (snap.convs.get(key) && !snap.convs.get(key)!.stale) return; // inzwischen selbst begonnen
          putConv({ key, agent, sessionId, state: { ...initialState, items: historyItems(m) }, touched: Date.now() });
        })
        .catch((e: Error) => {
          if (snap.convs.get(key) && !snap.convs.get(key)!.stale) return;
          putConv({ key, agent, sessionId, state: { ...initialState, runStatus: "failed", error: e.message }, stale: true, touched: Date.now() });
        })
        .finally(() => loading.delete(key));
    },

    send,
    sendQueued,
    enqueue: (key: string, text: string, images: string[]) => dispatch(key, { type: "queue-add", text, images }),
    dropQueued: (key: string, id: string) => dispatch(key, { type: "queue-remove", id }),

    /** Nachricht in den laufenden Run einschieben (Steer). */
    async steer(key: string, text: string) {
      const conv = snap.convs.get(key);
      if (!conv?.state.runId) return;
      dispatch(key, { type: "steered", text });
      await api.steer(conv.agent, conv.state.runId, text).catch((e: Error) => dispatch(key, { type: "notice", error: e.message }));
    },

    async stop(key: string) {
      const conv = snap.convs.get(key);
      if (conv?.state.runId) await api.stop(conv.agent, conv.state.runId).catch(() => undefined);
    },

    async decide(key: string, itemId: string, decision: Decision) {
      const conv = snap.convs.get(key);
      if (!conv?.state.runId) return;
      const item = conv.state.items.find((i) => i.kind === "approval" && i.id === itemId);
      dispatch(key, { type: "decided", id: itemId, decision });
      try {
        await api.approve(conv.agent, conv.state.runId, decision);
        if (item?.kind === "approval") log({ id: `${key}:${itemId}`, at: Date.now(), agent: conv.agent, text: `${item.command} · ${DECISION_DONE[decision]}` });
      } catch (e) {
        // Karte wieder freigeben, damit die Person es erneut versuchen kann (z. B. nach neuer Anmeldung).
        dispatch(key, { type: "decision-failed", id: itemId });
        dispatch(key, { type: "notice", error: (e as Error).message, code: e instanceof ApiError ? e.code : undefined });
      }
    },

    async answer(key: string, itemId: string, text: string, clarifyId?: string) {
      const conv = snap.convs.get(key);
      if (!conv?.state.runId) return;
      const item = conv.state.items.find((i) => i.kind === "clarify" && i.id === itemId);
      dispatch(key, { type: "answered", id: itemId, answer: text });
      try {
        await api.clarify(conv.agent, conv.state.runId, text, clarifyId);
        if (item?.kind === "clarify") log({ id: `${key}:${itemId}`, at: Date.now(), agent: conv.agent, text: `Rückfrage beantwortet · ${item.question}` });
      } catch (e) {
        dispatch(key, { type: "notice", error: (e as Error).message });
      }
    },

    reconnect(key: string) {
      const runId = snap.convs.get(key)?.state.runId;
      if (runId) attach(key, runId);
    },

    /** Fehlermeldung in der Inbox als gelesen markieren. */
    dismiss(id: string) { commit({ dismissed: new Set(snap.dismissed).add(id) }); },

    /** Alles schließen (Abmelden, Tests). */
    dispose() { [...sources.keys()].forEach(closeSource); },
  };
}

export type RunStore = ReturnType<typeof createRunStore>;
