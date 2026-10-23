import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import { poll } from "./poll";
import type { Room, RoomMember } from "./types";
import { toMemberAsk, type MemberAsk } from "./useRoom";

/** Etwas in einem Raum, das auf die Person wartet: eine Freigabe, eine Rückfrage eines laufenden Mitglieds oder ein `@user`. */
export type RoomNeed = { id: string; room: Room; ask?: MemberAsk; member?: RoomMember };

type State = { needs: RoomNeed[]; refresh: () => void };
const Ctx = createContext<State>({ needs: [], refresh: () => undefined });
const POLL_MS = 15_000;

/** Eine Zeile je offener Freigabe/Rückfrage und je Raum, der die Person gerufen hat. Rein, damit sich das ohne Browser testen lässt. */
export function roomNeedsOf(rooms: Room[]): RoomNeed[] {
  return rooms.flatMap((room) => [
    ...(room.asks ?? []).map((a): RoomNeed => ({ id: `${room.id}:${a.run_id}`, room, ask: toMemberAsk(a), member: room.members.find((m) => m.key === a.member) })),
    ...(room.needs_user ? [{ id: `${room.id}:user`, room }] : []),
  ]);
}

/**
 * Räume, in denen etwas auf die Person wartet. Das kommt vom Server (offene Freigaben und Rückfragen laufender Mitglieder
 * liegen dort), nicht aus einer geöffneten Raumseite. Aufgefrischt wird alle 15 s (nur bei sichtbarem Tab) und beim Zurückkehren ins Fenster; Fehler bleiben still.
 */
export function RoomNeedsProvider({ children }: { children: ReactNode }) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const alive = useRef(true);

  const load = useCallback(() => api.rooms(false).then((r) => { if (alive.current) setRooms(r.rooms.filter((x) => x.needs_user || (x.asks?.length ?? 0) > 0)); }), []);
  const refresh = useCallback(() => { load().catch(() => undefined); }, [load]);

  useEffect(() => {
    alive.current = true;
    refresh();
    const stop = poll(load, POLL_MS); // Fehler bleiben still, der Takt wird bei Fehlern aber länger
    return () => { alive.current = false; stop(); };
  }, [load, refresh]);

  const needs = useMemo(() => roomNeedsOf(rooms), [rooms]);
  const value = useMemo(() => ({ needs, refresh }), [needs, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useRoomNeeds = () => useContext(Ctx);
