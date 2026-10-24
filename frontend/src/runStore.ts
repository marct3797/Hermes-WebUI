import { ApiError, api as realApi } from "./api";
import { chatReducer, historyItems, initialState, type Action } from "./chatReducer";
import { modelOptions, type Reasoning } from "./composerLogic";
import { agentKey } from "./router";
import { TERMINAL_EVENTS, type AgentRef, type ChatState, type Decision, type StreamEvent } from "./types";

/**
 * Alle Unterhaltungen dieser WebUI mit ihrem Run-Zustand, unabhängig davon, welche Seite gerade offen ist.
 * Ein Run läuft weiter, wenn man zum Cockpit wechselt; Cockpit, Inbox und Seitenleiste lesen denselben Zustand.
 * Sichtbar sind nur Runs, die diese WebUI selbst gestartet hat (Runs aus CLI oder Cron kennt Hermes' API nicht als Liste).
 */

export const NEW = "new";
const idempotencyKey = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
export const convKey = (a: AgentRef, sessionId?: string) => `${agentKey(a)}#${sessionId ?? NEW}`;

export type Conv = {
  key: string;
  agent: AgentRef;
  sessionId?: string;
  state: ChatState;
  /** Modell der letzten Auswahl; vorgemerkte Nachrichten gehen damit los. */
  model?: string;
  /** Letzter Denk-Aufwand dieser Unterhaltung; vorgemerkte Nachrichten gehen damit los. */
  reasoning?: Reasoning;
  /** Verlauf konnte nicht geladen werden: beim nächsten Öffnen erneut versuchen. */
  stale?: boolean;
  touched: number;
};

/** Eine erledigte Entscheidung (Inbox: „Erledigt heute“). */
export type LogEntry = { id: string; at: number; agent: AgentRef; text: string };

export type Snapshot = { convs: ReadonlyMap<string, Conv>; log: readonly LogEntry[]; dismissed: ReadonlySet<string> };

type Deps = { api: typeof realApi; eventSource: (url: string) => EventSource; storage?: Storage };
type SendOpts = { model?: string; reasoning?: Reasoning; onSession?: (sessionId: string) => void };
type Source = { es: EventSource; holder: { key: string }; finished: boolean };

const MAX_CONVS = 40;
export const DECISION_DONE: Record<Decision, string> = {
  once: "einmal erlaubt", session: "für die Session erlaubt", always: "dauerhaft erlaubt", deny: "abgelehnt",
};

const live = (s: ChatState) => s.runStatus === "starting" || s.runStatus === "running";

export function createRunStore(deps: Deps = { api: realApi, eventSource: (u) => new EventSource(u) }) {
  const { api } = deps;
  let storage: Storage | undefined = deps.storage;
  try { if (!storage && api === realApi) storage = globalThis.sessionStorage; } catch { /* private mode */ }
  let disposed = false;
  let notifications = false;
  const restored = new Map<string, Conv>();
  try {
    notifications = storage?.getItem("hermes-run-notifications") === "true";
    const saved: unknown = JSON.parse(storage?.getItem("hermes-known-runs") ?? "[]");
    if (Array.isArray(saved)) for (const row of saved.slice(-MAX_CONVS)) {
      if (!row || typeof row !== "object" || !row.agent || ![row.agent.host, row.agent.runtime, row.agent.agent, row.runId, row.sessionId].every((v) => typeof v === "string" && v.length > 0 && v.length < 256)) continue;
      const agent: AgentRef = { host: row.agent.host, runtime: row.agent.runtime, agent: row.agent.agent };
      const key = convKey(agent, row.sessionId);
      const status = ["idle", "done", "failed", "stopped", "lost"].includes(row.status) ? row.status as ChatState["runStatus"] : "running";
      restored.set(key, { key, agent, sessionId: row.sessionId, state: { ...initialState, runId: row.runId, runStatus: status }, touched: Date.now(), stale: false });
    }
  } catch { /* corrupted or unavailable session storage must not break chat */ }
  let snap: Snapshot = { convs: restored, log: [], dismissed: new Set() };
  const listeners = new Set<() => void>();
  const endListeners = new Set<(agent: AgentRef) => void>();
  const sources = new Map<string, Source>();
  const loading = new Set<string>();
  const detailTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
  const detailBusy = new Set<string>();

  const commit = (next: Partial<Snapshot>) => {
    snap = { ...snap, ...next };
    try {
      storage?.setItem("hermes-known-runs", JSON.stringify([...snap.convs.values()].filter((c) => c.state.runId && c.sessionId).map((c) => ({ agent: c.agent, sessionId: c.sessionId, runId: c.state.runId, status: c.state.runStatus }))));
    } catch { /* storage quota or private mode */ }
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

  const runEnded = (agent: AgentRef, notify = true) => {
    endListeners.forEach((l) => l(agent));
    if (notify && notifications && typeof Notification !== "undefined" && Notification.permission === "granted") {
      try { new Notification("Hermes: Lauf beendet", { body: `${agent.host} · ${agent.agent}` }); } catch { /* unsupported platform */ }
    }
  };

  async function reconcile(key: string, runId: string, recovering = false) {
    const conv = snap.convs.get(key);
    if (!conv) return;
    try {
      const st = await api.runStatus(conv.agent, runId);
      if (disposed || snap.convs.get(key)?.state.runId !== runId) return;
      if (st.status && ["completed", "failed", "stopped", "cancelled", "canceled", "interrupted"].includes(st.status)) {
        closeSource(key);
        if (conv.sessionId) {
          try {
            const items = historyItems(await api.messages(conv.agent, conv.sessionId));
            if (disposed || snap.convs.get(key)?.state.runId !== runId) return;
            patch(key, { state: { ...initialState, items, runId } });
          }
          catch { /* retain the stream's existing content */ }
        }
        if (disposed || snap.convs.get(key)?.state.runId !== runId) return;
        if (st.status === "completed" && live(snap.convs.get(key)!.state)) dispatch(key, { type: "event", event: { type: "run.completed" } });
        if (["stopped", "cancelled", "canceled", "interrupted"].includes(st.status)) dispatch(key, { type: "event", event: { type: "run.stopped" } });
        else if (st.status === "failed") dispatch(key, { type: "event", event: { type: "run.failed", error: "Lauf fehlgeschlagen" } });
        patch(key, { stale: false });
        runEnded(conv.agent, !recovering);
        return;
      }
      if (recovering && st.status && ["running", "pending", "queued", "starting", "waiting"].includes(st.status)) {
        patch(key, { stale: false });
        dispatch(key, { type: "run-accepted", runId });
        attach(key, runId);
        return;
      }
    } catch { /* unknown is not a reason to replay work */ }
    dispatch(key, { type: "connection-lost" });
  }

  /**
   * Hermes' Ereignisstrom nennt weder Argumente noch Ausgabe eines Tools. Beides steht im Verlauf der Session:
   * Er wird nachgeladen und ergänzt die Tool-Karten (nach jedem beendeten Tool und noch einmal nach dem Run).
   */
  async function loadDetails(key: string) {
    const conv = snap.convs.get(key);
    if (!conv?.sessionId || detailBusy.has(key)) return;
    detailBusy.add(key);
    try {
      const items = historyItems(await api.messages(conv.agent, conv.sessionId));
      if (snap.convs.has(key)) dispatch(key, { type: "enrich", items });
    } catch { /* Verlauf nicht lesbar: die Karten bleiben, wie der Strom sie lieferte */ }
    finally { detailBusy.delete(key); }
  }

  function refreshDetails(key: string, ...delays: number[]) {
    for (const t of detailTimers.get(key) ?? []) clearTimeout(t);
    detailTimers.set(key, delays.map((ms) => setTimeout(() => { void loadDetails(key); }, ms)));
  }

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
      if (data.type === "tool.completed") refreshDetails(holder.key, 600);
      if (!TERMINAL_EVENTS.has(data.type)) return;
      refreshDetails(holder.key, 300, 2500);
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
      await reconcile(holder.key, runId);
    };
  }

  async function send(agent: AgentRef, sessionId: string | undefined, text: string, images: string[], opts: SendOpts = {}) {
    let key = ensure(agent, sessionId).key;
    patch(key, { model: opts.model, reasoning: opts.reasoning });
    dispatch(key, { type: "user-sent", text, images });
    try {
      // Der Schlüssel macht ein doppeltes Absenden (zweimal getippt, Wiederholung bei schlechtem Netz) zu einem einzigen Run.
      // Ohne Auswahl entfällt model_options ganz: der Agent nutzt seinen eigenen Standard.
      const body = { text, session_id: sessionId, model: opts.model, images: images.length ? images : undefined, idempotency_key: idempotencyKey(), model_options: modelOptions(opts.reasoning) };
      const run = await api.startRun(agent, body);
      if (run.session_id && run.session_id !== sessionId) {
        key = rekey(key, run.session_id);
        opts.onSession?.(run.session_id);
      }
      dispatch(key, { type: "run-accepted", runId: run.run_id });
      attach(key, run.run_id);
    } catch (e) {
      // Sessions aus Discord, CLI oder Cron lassen sich über die API nicht fortsetzen (409): die Ansicht bietet einen Fork an.
      const locked = sessionId !== undefined && e instanceof ApiError && e.status === 409;
      dispatch(key, locked
        ? { type: "run-error", error: "Diese Session gehört zu einer anderen Quelle (z. B. Discord) und lässt sich hier nicht fortsetzen.", code: "session_locked" }
        : { type: "run-error", error: (e as Error).message });
    }
  }

  function sendQueued(key: string, id: string) {
    const conv = snap.convs.get(key);
    const item = conv?.state.queued.find((q) => q.id === id);
    if (!conv || !item) return;
    dispatch(key, { type: "queue-remove", id });
    void send(conv.agent, conv.sessionId, item.text, item.images, { model: conv.model, reasoning: conv.reasoning });
  }

  queueMicrotask(() => {
    if (disposed) return;
    for (const c of restored.values()) {
      if (live(c.state) || c.state.runStatus === "lost") { if (c.state.runId) void reconcile(c.key, c.state.runId, true); }
      else if (c.sessionId) void api.messages(c.agent, c.sessionId).then((messages) => {
        if (!disposed && snap.convs.get(c.key)?.state.runId === c.state.runId) patch(c.key, { state: { ...c.state, items: historyItems(messages) } });
      }).catch(() => { /* finished work stays finished even if upstream retention expired */ });
    }
  });

  return {
    get notificationsEnabled() { return notifications; },
    async setNotifications(enabled: boolean) {
      notifications = enabled && typeof Notification !== "undefined" && (Notification.permission === "granted" || await Notification.requestPermission() === "granted");
      try { storage?.setItem("hermes-run-notifications", String(notifications)); } catch { /* private mode */ }
      return notifications;
    },
    subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    getSnapshot: () => snap,
    /** Ein Run dieses Agents ist zu Ende (für das Auffrischen der Session-Liste). */
    onRunEnd(cb: (agent: AgentRef) => void) { endListeners.add(cb); return () => { endListeners.delete(cb); }; },

    /**
     * Die Ansicht einer Unterhaltung wird geöffnet. Bekannte Unterhaltungen (auch beendete) bleiben, wie sie sind:
     * Ihre Karten haben den Strom gesehen und tragen bereits die nachgeladenen Details. Unbekannte Sessions laden ihren Verlauf.
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
    enqueue: (key: string, text: string, images: string[], reasoning?: Reasoning) => { patch(key, { reasoning }); dispatch(key, { type: "queue-add", text, images }); },
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

    /** Eine nicht fortsetzbare Session (Discord, CLI, Cron) als Fork weiterführen: Verlauf kopieren, die letzte Nachricht dort senden. */
    async continueInFork(key: string, onSession: (sessionId: string) => void) {
      const conv = snap.convs.get(key);
      const last = conv && [...conv.state.items].reverse().find((i) => i.kind === "message" && i.role === "user");
      if (!conv?.sessionId || last?.kind !== "message") return;
      try {
        const { session_id } = await api.fork(conv.agent, conv.sessionId);
        const forkKey = convKey(conv.agent, session_id);
        putConv({ key: forkKey, agent: conv.agent, sessionId: session_id, state: { ...initialState, items: historyItems(await api.messages(conv.agent, session_id)) }, model: conv.model, touched: Date.now() });
        onSession(session_id);
        await send(conv.agent, session_id, last.text, last.images, { model: conv.model, reasoning: conv.reasoning, onSession });
      } catch (e) {
        dispatch(key, { type: "notice", error: `Fork nicht möglich: ${(e as Error).message}`, code: "session_locked" });
      }
    },

    reconnect(key: string) {
      const runId = snap.convs.get(key)?.state.runId;
      if (runId) void reconcile(key, runId, true);
    },

    /** Fehlermeldung in der Inbox als gelesen markieren. */
    dismiss(id: string) { commit({ dismissed: new Set(snap.dismissed).add(id) }); },

    /** Alles schließen (Abmelden, Tests). */
    dispose() {
      disposed = true;
      [...sources.keys()].forEach(closeSource);
      detailTimers.forEach((ts) => ts.forEach(clearTimeout));
      detailTimers.clear();
    },
  };
}

export type RunStore = ReturnType<typeof createRunStore>;
