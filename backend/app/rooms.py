"""Gruppenchats („Räume“): mehrere Agents in einem Gespräch, gesteuert vom BFF.

Hermes' Desktop-App hat Räume über eine eigene Gateway-Schnittstelle, die HTTP-API kennt sie nicht. Die WebUI baut sie darum
mit normalen Runs nach: Jedes Mitglied bekommt eine eigene Session in seinem Agent (dort liegt sein Gedächtnis des Raums),
das BFF führt das Gespräch. Die Regeln folgen der Doku von Hermes:

- 2 bis 6 Mitglieder. Eine Nachricht der Person löst bis zu 3 Runden aus, höchstens 10 Agent-Nachrichten je Absenden.
- Erste Runde: die @-Erwähnten antworten, ohne Erwähnung alle (`@all` ebenso). Danach antworten die, die ein Mitglied in
  der Runde davor erwähnt hat. Wer nichts beitragen will, antwortet mit `[PASS]`. Eine stille Runde beendet das Absenden.
- `@user` in einer Agent-Nachricht heißt „braucht dich“: der Raum merkt es sich und hält an, sobald niemand sonst mehr dran ist.
  Wer in derselben Nachricht auch ein Mitglied erwähnt („@bert prüf das, ich sage es @user“), lässt dieses Mitglied nicht warten.
- Jedes Mitglied sieht je Zug die Raumnachrichten seit seinem letzten Zug.

Gespeichert wird in SQLite (Raumliste, Nachrichten, Session je Mitglied). Gelöscht wird nichts; ein Raum lässt sich nur archivieren.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import sqlite3
import threading
import time
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .adapters import RunInput, UpstreamError
from .events import TERMINAL_TYPES

log = logging.getLogger("hermes_webui.rooms")

ROOM_ID_RE = re.compile(r"^[0-9a-f]{12}$")
MIN_MEMBERS, MAX_MEMBERS = 2, 6
MAX_ROUNDS = 3
MAX_AGENT_MESSAGES = 10
RUN_TIMEOUT_S = 900.0  # eine Freigabe, auf die die Person wartet, zählt mit
PASS_TOKEN = "[PASS]"
MENTION_RE = re.compile(r"(?<![\w@])@(\w[\w-]*)")  # \w: auch Umlaute und Kanji in Anzeigenamen

Member = dict[str, str]  # {"host", "runtime", "agent"}


def member_key(m: Member) -> str:
    return f"{m['host']}/{m['runtime']}/{m['agent']}"


class RoomError(Exception):
    """Fehler mit HTTP-Status für die Route."""

    def __init__(self, status: int, detail: str):
        self.status, self.detail = status, detail
        super().__init__(detail)


# --- Reine Hilfen (ohne Netz, einzeln testbar) -------------------------------------------------------
def parse_mentions(text: str, names: dict[str, str]) -> list[str]:
    """Erwähnungen in Reihenfolge des Auftretens: Mitglieds-Schlüssel, `all` oder `user`. `names`: kleingeschriebener Name -> Schlüssel."""
    out: list[str] = []
    for raw in MENTION_RE.findall(text):
        name = raw.lower().rstrip("-_")
        hit = "all" if name in ("all", "alle") else "user" if name == "user" else names.get(name)
        if hit is None and name not in ("all", "alle", "user"):
            # „@eta-san“ oder „@eta_bot“: ein Anhängsel nach - oder _ ändert nicht, wer gemeint ist
            hit = names.get(re.split(r"[-_]", name, maxsplit=1)[0])
        if hit and hit not in out:
            out.append(hit)
    return out


def is_pass(text: str) -> bool:
    return text.strip().upper().startswith(PASS_TOKEN)


def build_prompt(room: str, me: str, others: list[str], fresh: list[dict[str, Any]], names: dict[str, str], addressed: bool = False,
                 labels: dict[str, str] | None = None) -> str:
    """Was ein Mitglied in seinem Zug erhält: die Spielregeln kurz, dann die Raumnachrichten seit seinem letzten Zug.

    `addressed`: jemand hat das Mitglied mit @Name angesprochen. Dann soll es antworten, nicht passen."""
    label: dict[str, str] = dict(labels or {})
    for lab, key in names.items():
        label.setdefault(key, lab)  # ohne `labels`: der kleingeschriebene Anzeigename; `names` nennt ihn je Mitglied vor der Agent-Kennung
    lines = []
    for m in fresh:
        who = "Person" if m["author"] == "user" else label.get(m["author"], m["author"])
        lines.append(f"{who}: {m['text']}")
    others_text = ", ".join(others) if others else "niemand sonst"
    direct = f"\n\nDu wurdest mit @{me} direkt angesprochen: Antworte darauf, schicke nicht {PASS_TOKEN}." if addressed else ""
    return (
        f"Du bist „{me}“ in dem Gruppenchat „{room}“. Weitere Mitglieder: {others_text}. Die Person im Raum heißt „Person“.\n"
        "Regeln: Antworte knapp und im Gesprächston. Soll ein bestimmtes Mitglied antworten, erwähne es mit @Name. "
        f"Wirst du mit @Name angesprochen, antworte immer. Hast du sonst nichts beizutragen, antworte genau mit {PASS_TOKEN}. "
        "Erwähne @user nur, wenn du ohne Entscheidung der Person nicht weiterkommst; sonst schreib „die Person“ ohne @.\n\n"
        "Neu im Raum seit deinem letzten Beitrag:\n" + "\n".join(lines) + direct
    )


# --- Speicher ----------------------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, members TEXT NOT NULL, sessions TEXT NOT NULL DEFAULT '{}',
  cursors TEXT NOT NULL DEFAULT '{}', owner TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0, needs_user INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  room_id TEXT NOT NULL, seq INTEGER NOT NULL, author TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
  mentions TEXT NOT NULL DEFAULT '[]', at REAL NOT NULL, PRIMARY KEY (room_id, seq)
);
"""


class RoomStore:
    def __init__(self, path: Path | str):
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._db.executescript(SCHEMA)

    @staticmethod
    def _room(row: sqlite3.Row) -> dict[str, Any]:
        return {"id": row["id"], "name": row["name"], "members": json.loads(row["members"]), "sessions": json.loads(row["sessions"]),
                "cursors": json.loads(row["cursors"]), "owner": row["owner"], "created_at": row["created_at"],
                "archived": bool(row["archived"]), "needs_user": bool(row["needs_user"])}

    @staticmethod
    def _message(row: sqlite3.Row) -> dict[str, Any]:
        return {"seq": row["seq"], "author": row["author"], "kind": row["kind"], "text": row["text"],
                "mentions": json.loads(row["mentions"]), "at": row["at"]}

    def create(self, name: str, members: list[Member], owner: str) -> dict[str, Any]:
        rid = uuid.uuid4().hex[:12]
        with self._lock:
            self._db.execute("INSERT INTO rooms (id, name, members, owner, created_at) VALUES (?,?,?,?,?)",
                             (rid, name, json.dumps(members), owner, time.time()))
        return self.get(rid)  # type: ignore[return-value]

    def get(self, rid: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute("SELECT * FROM rooms WHERE id=?", (rid,)).fetchone()
        return self._room(row) if row else None

    def rooms(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute("SELECT * FROM rooms ORDER BY created_at DESC").fetchall()
            out = [self._room(r) for r in rows]
            for r in out:
                last = self._db.execute("SELECT * FROM messages WHERE room_id=? AND kind='message' ORDER BY seq DESC LIMIT 1", (r["id"],)).fetchone()
                r["last_message"] = self._message(last) if last else None
        return out

    def update(self, rid: str, **fields: Any) -> None:
        allowed = {"name", "archived", "needs_user", "sessions", "cursors"}
        sets, args = [], []
        for k, v in fields.items():
            if k not in allowed:
                raise ValueError(k)
            sets.append(f"{k}=?")
            args.append(json.dumps(v) if isinstance(v, dict) else int(v) if isinstance(v, bool) else v)
        if sets:
            with self._lock:
                self._db.execute(f"UPDATE rooms SET {', '.join(sets)} WHERE id=?", (*args, rid))

    def add_message(self, rid: str, author: str, kind: str, text: str, mentions: list[str] | None = None) -> dict[str, Any]:
        with self._lock:
            seq = (self._db.execute("SELECT COALESCE(MAX(seq),0)+1 FROM messages WHERE room_id=?", (rid,)).fetchone()[0])
            at = time.time()
            self._db.execute("INSERT INTO messages (room_id, seq, author, kind, text, mentions, at) VALUES (?,?,?,?,?,?,?)",
                             (rid, seq, author, kind, text, json.dumps(mentions or []), at))
        return {"seq": seq, "author": author, "kind": kind, "text": text, "mentions": mentions or [], "at": at}

    def messages(self, rid: str, after: int = 0, limit: int | None = 200) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute("SELECT * FROM messages WHERE room_id=? AND seq>? ORDER BY seq LIMIT ?", (rid, after, -1 if limit is None else limit)).fetchall()
        return [self._message(r) for r in rows]

    def page(self, rid: str, after: int | None, before: int | None, limit: int) -> dict[str, Any]:
        with self._lock:
            if after is not None:
                rows = self._db.execute("SELECT * FROM messages WHERE room_id=? AND seq>? ORDER BY seq LIMIT ?", (rid, after, limit + 1)).fetchall()
                has_more = len(rows) > limit
                rows = rows[:limit]
            else:
                rows = self._db.execute("SELECT * FROM messages WHERE room_id=? AND seq<? ORDER BY seq DESC LIMIT ?", (rid, before if before is not None else 9223372036854775807, limit)).fetchall()[::-1]
                has_more = False
            first = rows[0]["seq"] if rows else before
            has_older = bool(first and self._db.execute("SELECT 1 FROM messages WHERE room_id=? AND seq<? LIMIT 1", (rid, first)).fetchone())
        return {"messages": [self._message(r) for r in rows], "has_more": has_more,
                "has_older": has_older, "next_before": first,
                "next_after": rows[-1]["seq"] if rows else (after or 0)}

    def last_seq(self, rid: str) -> int:
        with self._lock:
            return self._db.execute("SELECT COALESCE(MAX(seq),0) FROM messages WHERE room_id=?", (rid,)).fetchone()[0]


# --- Ablauf ------------------------------------------------------------------------------------------
@dataclass
class Turn:
    id: str
    room_id: str
    task: asyncio.Task | None = None
    stop: bool = False
    speaker: str | None = None
    current: tuple[Any, str] | None = None  # (Target, run_id) des laufenden Zugs
    last_run: str | None = None  # Run des letzten Mitglieds-Zugs, für die Fehlersuche bei leeren Antworten
    reason: str = "idle"


class RoomEngine:
    """Führt Gespräche aus. `targets` löst (host, runtime, agent) in ein Ziel mit Adapter auf (HostService.target)."""

    def __init__(self, store: RoomStore, targets: Callable[[str, str, str], Any]):
        self.store, self._targets = store, targets
        self.turns: dict[str, Turn] = {}
        self.asks: dict[str, dict[str, dict[str, Any]]] = {}  # Raum -> Run -> offene Freigabe oder Rückfrage
        self._subs: dict[str, set[asyncio.Queue]] = {}

    # -- Abos für den Ereignisstrom --
    def subscribe(self, rid: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=2000)
        self._subs.setdefault(rid, set()).add(q)
        return q

    def unsubscribe(self, rid: str, q: asyncio.Queue) -> None:
        self._subs.get(rid, set()).discard(q)

    def _publish(self, rid: str, event: dict[str, Any]) -> None:
        for q in list(self._subs.get(rid, ())):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass  # ein Abo, das nicht mitkommt, verliert Zwischenereignisse; die Nachrichten holt es per GET nach

    def status(self, rid: str) -> dict[str, Any]:
        t = self.turns.get(rid)
        return {"running": t is not None, "speaker": t.speaker if t else None, "asks": self.open_asks(rid)}

    # -- Offene Fragen der Mitglieder --
    def open_asks(self, rid: str) -> list[dict[str, Any]]:
        """Freigaben und Rückfragen, auf die ein Lauf im Raum gerade wartet. Der Server hält sie, damit sie nicht an einer
        offenen Seite hängen: Wer den Raum erst später öffnet oder nur das Cockpit ansieht, sieht sie trotzdem."""
        return sorted((dict(a) for a in self.asks.get(rid, {}).values()), key=lambda a: a["at"])

    def _track_ask(self, rid: str, key: str, run_id: str, ev: dict[str, Any]) -> None:
        kind, asks = ev["type"], self.asks.setdefault(rid, {})
        if kind == "approval.requested":
            asks[run_id] = {"kind": "approval", "member": key, "run_id": run_id, "command": ev.get("command", ""), "reason": ev.get("reason", ""),
                            "choices": ev.get("choices") or [], "timeout_s": ev.get("timeout_s"), "at": time.time()}
        elif kind == "clarify.requested":
            asks[run_id] = {"kind": "clarify", "member": key, "run_id": run_id, "clarify_id": ev.get("clarify_id"), "question": ev.get("question", ""),
                            "choices": ev.get("choices") or [], "at": time.time()}
        else:
            ask = asks.get(run_id)
            # Hermes meldet nur Freigaben als beantwortet; eine Rückfrage ist erledigt, sobald der Lauf weiterarbeitet.
            if not ask or not (kind == "approval.responded" and ask["kind"] == "approval"
                               or kind in ("message.delta", "tool.started", "tool.completed") and ask["kind"] == "clarify"
                               or kind in TERMINAL_TYPES):
                return
            del asks[run_id]
        self._publish(rid, {"type": "asks", "asks": self.open_asks(rid)})

    def _drop_asks(self, rid: str, run_id: str | None = None) -> None:
        """Räumt Fragen weg, wenn ihr Lauf endet (oder der Raum fertig ist), und sagt es den Abos."""
        asks = self.asks.get(rid, {})
        gone = [run_id] if run_id else list(asks)
        if any(asks.pop(g, None) for g in gone):
            self._publish(rid, {"type": "asks", "asks": self.open_asks(rid)})
        if not asks:
            self.asks.pop(rid, None)

    # -- Zugriffe --
    def names(self, room: dict[str, Any]) -> dict[str, str]:
        """Kleingeschriebener Anzeigename (Label des Agents) -> Schlüssel des Mitglieds."""
        out: dict[str, str] = {}
        for m in room["members"]:
            t = self._targets(m["host"], m["runtime"], m["agent"])
            out[(t.agent.label if t else m["agent"]).lower()] = member_key(m)
            out.setdefault(m["agent"].lower(), member_key(m))
        return out

    def label_of(self, m: Member) -> str:
        t = self._targets(m["host"], m["runtime"], m["agent"])
        return t.agent.label if t else m["agent"]

    # -- Absenden und Stoppen --
    async def send(self, rid: str, text: str, user: str) -> dict[str, Any]:
        room = self.store.get(rid)
        if room is None:
            raise RoomError(404, "Unbekannter Raum")
        if room["archived"]:
            raise RoomError(409, "Der Raum ist archiviert")
        if rid in self.turns:
            raise RoomError(409, "Der Raum arbeitet noch: Stopp drücken oder abwarten")
        missing = [member_key(m) for m in room["members"] if self._targets(m["host"], m["runtime"], m["agent"]) is None]
        if missing:
            raise RoomError(409, f"Mitglieder nicht mehr in der Konfiguration: {', '.join(missing)}")
        names = self.names(room)
        msg = self.store.add_message(rid, "user", "message", text, parse_mentions(text, names))
        self.store.update(rid, needs_user=False)
        self._publish(rid, {"type": "message", "message": msg})
        turn = Turn(id=uuid.uuid4().hex[:8], room_id=rid)
        self.turns[rid] = turn
        turn.task = asyncio.create_task(self._run(turn, room, msg, names))
        return msg

    async def stop(self, rid: str) -> bool:
        turn = self.turns.get(rid)
        if turn is None:
            return False
        turn.stop = True
        if turn.current:
            target, run_id = turn.current
            try:
                await target.adapter.stop(target.agent.id, run_id)
            except UpstreamError:
                pass  # der Lauf ist schon zu Ende
        return True

    async def shutdown(self) -> None:
        tasks = [t.task for t in self.turns.values() if t.task]
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    # -- Das Gespräch --
    async def _run(self, turn: Turn, room: dict[str, Any], trigger: dict[str, Any], names: dict[str, str]) -> None:
        rid = room["id"]
        order = [member_key(m) for m in room["members"]]
        self._publish(rid, {"type": "turn.started", "turn": turn.id})
        try:
            speakers = self._first_speakers(order, trigger)
            produced_total = 0
            for round_no in range(1, MAX_ROUNDS + 1):
                if not speakers:
                    break
                produced: list[dict[str, Any]] = []
                for key in speakers:
                    if turn.stop:
                        turn.reason = "stopped"
                        return
                    if produced_total >= MAX_AGENT_MESSAGES:
                        turn.reason = "max_messages"
                        return
                    msg = await self._member_turn(turn, room, key, round_no, names)
                    if msg:
                        produced.append(msg)
                        produced_total += 1
                if turn.stop:
                    turn.reason = "stopped"
                    return
                if any("user" in m["mentions"] for m in produced):
                    self.store.update(rid, needs_user=True)
                    turn.reason = "needs_user"
                speakers = self._next_speakers(order, produced)
                if speakers and round_no == MAX_ROUNDS and turn.reason != "needs_user":
                    turn.reason = "max_rounds"
        except asyncio.CancelledError:
            turn.reason = "stopped"
            raise
        except Exception:  # noqa: BLE001 - ein Fehler im Ablauf darf den Raum nicht hängen lassen
            log.exception("Raum %s: Ablauf abgebrochen", rid)
            turn.reason = "error"
            sysmsg = self.store.add_message(rid, "system", "system", "Der Ablauf wurde wegen eines Fehlers abgebrochen.")
            self._publish(rid, {"type": "message", "message": sysmsg})
        finally:
            self.turns.pop(rid, None)
            self._drop_asks(rid)
            self._publish(rid, {"type": "turn.finished", "turn": turn.id, "reason": turn.reason})

    @staticmethod
    def _first_speakers(order: list[str], trigger: dict[str, Any]) -> list[str]:
        asked = [k for k in trigger["mentions"] if k in order]
        if "all" in trigger["mentions"] or not asked:
            return list(order)
        return [k for k in order if k in asked]

    @staticmethod
    def _next_speakers(order: list[str], produced: list[dict[str, Any]]) -> list[str]:
        """Wer in der nächsten Runde dran ist: die, die jemand anderes in dieser Runde erwähnt hat."""
        wanted: set[str] = set()
        for m in produced:
            for k in m["mentions"]:
                if k == "all":
                    wanted |= {o for o in order if o != m["author"]}
                elif k in order and k != m["author"]:
                    wanted.add(k)
        return [k for k in order if k in wanted]

    async def _member_turn(self, turn: Turn, room: dict[str, Any], key: str, round_no: int, names: dict[str, str]) -> dict[str, Any] | None:
        rid = room["id"]
        member = next(m for m in room["members"] if member_key(m) == key)
        target = self._targets(member["host"], member["runtime"], member["agent"])
        label = target.agent.label if target else member["agent"]
        fresh_room = self.store.get(rid) or room
        cursor = int(fresh_room["cursors"].get(key, 0))
        last = self.store.last_seq(rid)
        fresh = [m for m in self.store.messages(rid, after=cursor, limit=None) if m["seq"] <= last and m["kind"] == "message" and m["author"] != key]
        if not fresh:
            return None
        others = [self.label_of(m) for m in room["members"] if member_key(m) != key]
        addressed = any(key in m["mentions"] for m in fresh)
        prompt = build_prompt(room["name"], label, others, fresh, names, addressed, {member_key(m): self.label_of(m) for m in room["members"]})
        turn.speaker = key
        self._publish(rid, {"type": "member.started", "member": key, "round": round_no})
        text, error = "", None
        try:
            info = await target.adapter.start_run(target.agent.id, RunInput(
                text=prompt, session_id=fresh_room["sessions"].get(key),
                idempotency_key=f"room-{rid}-{last}-{round_no}-{hashlib.sha1(key.encode()).hexdigest()[:8]}"))
            turn.current = (target, info.run_id)
            turn.last_run = info.run_id
            if info.session_id and fresh_room["sessions"].get(key) != info.session_id:
                sessions = {**fresh_room["sessions"], key: info.session_id}
                self.store.update(rid, sessions=sessions)
                await self._name_session(target, info.session_id, f"Gruppe: {room['name']} · {label}")
            self.store.update(rid, cursors={**(self.store.get(rid) or room)["cursors"], key: last})
            text, error = await asyncio.wait_for(self._collect(rid, key, target, info.run_id), RUN_TIMEOUT_S)
        except asyncio.TimeoutError:
            error = f"keine Antwort nach {int(RUN_TIMEOUT_S // 60)} Minuten"
            if turn.current:
                try:
                    await target.adapter.stop(target.agent.id, turn.current[1])
                except UpstreamError:
                    pass
        except UpstreamError as e:
            error = e.detail
        finally:
            turn.current = None
            turn.speaker = None
        if error and not text.strip():
            if turn.stop:
                return None
            self._publish(rid, {"type": "member.passed", "member": key})  # nimmt die „schreibt…“-Zeile weg
            self._note(rid, f"{label} konnte nicht antworten: {error}")
            return None
        if not text.strip():
            # Ohne diese Zeile verschwände der Beitrag spurlos („er schreibt kurz und dann kommt nichts“).
            self._publish(rid, {"type": "member.passed", "member": key})
            why = await self._why_empty(target, turn.last_run) if turn.last_run else ""
            self._note(rid, f"{label} hat nichts geantwortet: Hermes lieferte einen leeren Lauf{f' ({why})' if why else ''}.")
            return None
        if is_pass(text):
            self._publish(rid, {"type": "member.passed", "member": key})
            if addressed:
                self._note(rid, f"{label} wurde angesprochen und hat mit {PASS_TOKEN} übergangen.")
            return None
        msg = self.store.add_message(rid, key, "message", text.strip(), parse_mentions(text, names))
        self._publish(rid, {"type": "message", "message": msg})
        if error and not turn.stop:
            self._note(rid, f"{label}: Der Lauf endete vorzeitig ({error}); der Beitrag ist unvollständig.")
        return msg

    def _note(self, rid: str, text: str) -> None:
        msg = self.store.add_message(rid, "system", "system", text)
        self._publish(rid, {"type": "message", "message": msg})

    @staticmethod
    async def _why_empty(target: Any, run_id: str) -> str:
        """Fehlertext aus dem Lauf-Status, falls Hermes einen nennt."""
        try:
            status = await target.adapter.run_status(target.agent.id, run_id)
        except Exception:  # noqa: BLE001 - nur Zusatzinfo für die Meldung
            return ""
        err = status.get("error") if isinstance(status, dict) else None
        if isinstance(err, dict):
            err = err.get("message")
        return str(err)[:200] if err else ""

    async def _collect(self, rid: str, key: str, target: Any, run_id: str) -> tuple[str, str | None]:
        """Liest den Ereignisstrom des Laufs, reicht ihn an die Abos weiter und liefert (Text, Fehler)."""
        text, interim, end = "", [], {}
        try:
            async for ev in target.adapter.events(target.agent.id, run_id):
                if ev["type"] == "message.delta":
                    text += ev.get("text", "")
                elif ev["type"] == "message.interim" and ev.get("text"):
                    interim.append(ev["text"])
                self._track_ask(rid, key, run_id, ev)
                self._publish(rid, {"type": "member.event", "member": key, "run_id": run_id, "event": ev})
                if ev["type"] in TERMINAL_TYPES:
                    end = ev
                    break
        finally:
            self._drop_asks(rid, run_id)  # auch bei Abbruch oder Zeitüberschreitung bleibt keine tote Frage stehen
        # Der Beitrag steht im Zeichenstrom, ersatzweise in der Endmeldung, zuletzt in den Zwischenmeldungen.
        final = text or str(end.get("text") or end.get("output") or "") or "\n\n".join(interim)
        if end.get("type") == "run.completed":
            return final, None
        return final, str(end.get("error") or end.get("type") or "Lauf ohne Abschluss")

    @staticmethod
    async def _name_session(target: Any, session_id: str, title: str) -> None:
        try:
            await target.adapter.rename_session(target.agent.id, session_id, title)
        except Exception:  # noqa: BLE001 - der Titel ist Komfort; doppelte Titel, fehlende Fähigkeit usw. sind kein Grund abzubrechen
            pass


# --- Dienst für die App ------------------------------------------------------------------------------
class RoomService:
    """Hält den Speicher und die Maschine und öffnet die Datenbank erst bei Bedarf: ein nicht beschreibbarer Ordner
    legt nur die Räume lahm, nicht das ganze BFF."""

    def __init__(self, path: Path | str, targets: Callable[[str, str, str], Any]):
        self._path, self._targets = path, targets
        self._engine: RoomEngine | None = None
        self.error: str | None = None

    @property
    def engine(self) -> RoomEngine:
        if self._engine is None:
            try:
                self._engine = RoomEngine(RoomStore(self._path), self._targets)
                self.error = None
            except (OSError, sqlite3.Error) as e:
                self.error = f"Raum-Speicher nicht nutzbar: {e}"
                raise RoomError(503, self.error) from e
        return self._engine

    async def shutdown(self) -> None:
        if self._engine:
            await self._engine.shutdown()


async def stream(engine: RoomEngine, rid: str, keepalive_s: float) -> AsyncIterator[dict[str, Any] | None]:
    """Ereignisse eines Raums; `None` heißt: Zeit für ein Keepalive."""
    q = engine.subscribe(rid)
    try:
        yield {"type": "state", **engine.status(rid)}
        while True:
            try:
                yield await asyncio.wait_for(q.get(), keepalive_s)
            except asyncio.TimeoutError:
                yield None
    finally:
        engine.unsubscribe(rid, q)
