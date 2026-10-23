import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Decision, Room, RoomAsk, RoomEvent, RoomMessage } from "./types";

/** Eine offene Frage eines Mitglieds an die Person: Freigabe oder Rückfrage. Sie gehört zum Run des Mitglieds. */
export type MemberAsk =
  | { kind: "approval"; member: string; runId: string; command: string; reason: string; choices: Decision[] }
  | { kind: "clarify"; member: string; runId: string; clarifyId?: string; question: string; choices: string[] };

export function toMemberAsk(a: RoomAsk): MemberAsk {
  return a.kind === "approval"
    ? { kind: "approval", member: a.member, runId: a.run_id, command: a.command, reason: a.reason, choices: a.choices }
    : { kind: "clarify", member: a.member, runId: a.run_id, clarifyId: a.clarify_id ?? undefined, question: a.question, choices: a.choices ?? [] };
}

/** Was ein Mitglied gerade tut, solange sein Beitrag noch nicht im Raum steht. */
export type Typing = { text: string; tool?: string };

export type RoomState = {
  room?: Room;
  messages: RoomMessage[];
  running: boolean;
  speaker: string | null;
  typing: Record<string, Typing>;
  asks: MemberAsk[];
  finished?: string;
  error?: string;
  hasOlder?: boolean;
  loadingOlder?: boolean;
};

const EMPTY: RoomState = { messages: [], running: false, speaker: null, typing: {}, asks: [] };

/** Fügt Nachrichten nach `seq` ein und lässt Doppelte weg (Verlauf und Ereignisstrom überlappen). */
export function mergeMessages(have: RoomMessage[], more: RoomMessage[]): RoomMessage[] {
  const bySeq = new Map(have.map((m) => [m.seq, m]));
  for (const m of more) bySeq.set(m.seq, m);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Wendet ein Raum-Ereignis auf den Zustand an. Rein, damit sich der Ablauf ohne Browser testen lässt. */
export function reduceRoom(s: RoomState, ev: RoomEvent): RoomState {
  switch (ev.type) {
    case "state": return { ...s, running: ev.running, speaker: ev.speaker, asks: (ev.asks ?? []).map(toMemberAsk) };
    case "asks": return { ...s, asks: ev.asks.map(toMemberAsk) };
    case "turn.started": return { ...s, running: true, finished: undefined };
    case "member.started": return { ...s, speaker: ev.member, typing: { ...s.typing, [ev.member]: { text: "" } } };
    case "member.passed": { const { [ev.member]: _gone, ...rest } = s.typing; return { ...s, typing: rest }; }
    case "message": {
      const { [ev.message.author]: _gone, ...rest } = s.typing;
      return { ...s, messages: mergeMessages(s.messages, [ev.message]), typing: rest };
    }
    case "member.event": {
      const e = ev.event;
      if (e.type === "message.delta") return { ...s, typing: { ...s.typing, [ev.member]: { ...s.typing[ev.member], text: (s.typing[ev.member]?.text ?? "") + e.text } } };
      if (e.type === "tool.started") return { ...s, typing: { ...s.typing, [ev.member]: { text: s.typing[ev.member]?.text ?? "", tool: e.name } } };
      return s;
    }
    case "turn.finished": return { ...s, running: false, speaker: null, typing: {}, asks: [], finished: ev.reason };
  }
}

/** Only REST advances the contiguous cursor; live messages may arrive beyond a reconnect gap. */
type RoomPage = Room & { has_more?: boolean; has_older?: boolean; next_after?: number; next_before?: number };
async function roomPage(roomId: string, query: string): Promise<RoomPage> {
  const response = await fetch(`/bff/rooms/${encodeURIComponent(roomId)}?${query}`, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`Raum nicht ladbar (${response.status})`);
  return response.json();
}

export function useRoom(roomId: string) {
  const [state, setState] = useState<RoomState>(EMPTY);
  const context = useRef({ disposed: false, cursor: undefined as number | undefined, before: undefined as number | undefined, busy: false, pending: false, older: false });

  const load = useCallback(async () => {
    const ctx = context.current;
    if (ctx.busy) { ctx.pending = true; return; }
    ctx.busy = true;
    try {
      do {
        ctx.pending = false;
        let more: boolean;
        do {
          const initial = ctx.cursor === undefined;
          const room: RoomPage = initial ? await api.room(roomId) : await roomPage(roomId, `after=${ctx.cursor}`);
          if (ctx.disposed) return;
          const cursor = room.next_after ?? room.messages?.at(-1)?.seq ?? ctx.cursor ?? 0;
          if (room.has_more && !initial && cursor <= ctx.cursor!) throw new Error("Ungültiger Raum-Cursor");
          ctx.cursor = cursor;
          if (initial) ctx.before = room.next_before ?? room.messages?.[0]?.seq;
          setState((s) => ({ ...s, room, messages: mergeMessages(s.messages, room.messages ?? []), running: room.running, speaker: room.speaker, hasOlder: initial ? !!room.has_older : s.hasOlder, error: undefined }));
          more = !!room.has_more;
        } while (more);
      } while (ctx.pending);
    } catch (e) {
      if (!ctx.disposed) setState((s) => ({ ...s, error: (e as Error).message }));
    } finally { ctx.busy = false; }
  }, [roomId]);

  const loadOlder = useCallback(async () => {
    const ctx = context.current;
    if (!ctx.before || ctx.older) return;
    ctx.older = true;
    setState((s) => ({ ...s, loadingOlder: true }));
    try {
      const page = await roomPage(roomId, `before=${ctx.before}`);
      if (ctx.disposed) return;
      ctx.before = page.next_before;
      setState((s) => ({ ...s, messages: mergeMessages(s.messages, page.messages ?? []), hasOlder: !!page.has_older, error: undefined }));
    } catch (e) {
      if (!ctx.disposed) setState((s) => ({ ...s, error: (e as Error).message }));
    } finally {
      ctx.older = false;
      if (!ctx.disposed) setState((s) => ({ ...s, loadingOlder: false }));
    }
  }, [roomId]);

  useEffect(() => {
    const ctx = { disposed: false, cursor: undefined as number | undefined, before: undefined as number | undefined, busy: false, pending: false, older: false };
    context.current = ctx;
    setState(EMPTY);
    void load();
    const es = new EventSource(api.roomEventsUrl(roomId));
    es.onmessage = (m) => {
      if (ctx.disposed) return;
      let ev: RoomEvent;
      try { ev = JSON.parse(m.data) as RoomEvent; } catch { return; }
      setState((s) => reduceRoom(s, ev));
      if (ev.type === "turn.finished" || ev.type === "state") void load();
    };
    return () => { ctx.disposed = true; es.close(); };
  }, [roomId, load]);

  return { state, reload: load, loadOlder };
}
