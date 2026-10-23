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

/** Raum laden und dem Ereignisstrom folgen. Nach dem Ende eines Zugs wird der Raum neu gelesen (Flag „braucht dich“). */
export function useRoom(roomId: string) {
  const [state, setState] = useState<RoomState>(EMPTY);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const room = await api.room(roomId);
      if (!alive.current) return;
      setState((s) => ({ ...s, room, messages: mergeMessages(s.messages, room.messages ?? []), running: room.running, speaker: room.speaker, error: undefined }));
    } catch (e) {
      if (alive.current) setState((s) => ({ ...s, error: (e as Error).message }));
    }
  }, [roomId]);

  useEffect(() => {
    alive.current = true;
    setState(EMPTY);
    void load();
    const es = new EventSource(api.roomEventsUrl(roomId));
    es.onmessage = (m) => {
      let ev: RoomEvent;
      try { ev = JSON.parse(m.data) as RoomEvent; } catch { return; }
      setState((s) => reduceRoom(s, ev));
      if (ev.type === "turn.finished" || ev.type === "state") void load(); // nach einem Wiederverbinden holt das die verpassten Nachrichten
    };
    return () => { alive.current = false; es.close(); };
  }, [roomId, load]);

  return { state, reload: load };
}
