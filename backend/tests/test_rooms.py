import asyncio
import time
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from app.adapters import RunInfo, UpstreamError
from app.main import create_app
from app.rooms import (MAX_AGENT_MESSAGES, RoomEngine, RoomError, RoomStore, build_prompt, is_pass, member_key, parse_mentions)
from devtools.mock_hermes import create_mock
from tests.conftest import HDR, RouterTransport


class FakeAdapter:
    """Agent, dessen Antwort ein Skript bestimmt: script(agent, prompt, nth) -> Text, Ereignisliste oder Exception.

    Eine Ereignisliste ersetzt den Standardablauf; der Eintrag "WAIT" hält den Lauf an, bis `release` gesetzt ist
    (so wartet ein Lauf auf eine Freigabe)."""

    def __init__(self, script):
        self.script, self.calls, self.stopped, self.titles, self.gate = script, [], [], [], None
        self.release, self.status = asyncio.Event(), {}
        self._runs: dict[str, tuple[str, str | list, int]] = {}

    async def start_run(self, agent, req):
        n = sum(1 for c in self.calls if c[0] == agent) + 1
        out = self.script(agent, req.text, n)
        if isinstance(out, Exception):
            raise out
        rid = f"run-{len(self.calls) + 1}"
        self.calls.append((agent, req.text, req.session_id, req.idempotency_key))
        self._runs[rid] = (agent, out, n)
        return RunInfo(rid, req.session_id or f"sess-{agent}")

    async def events(self, agent, run_id):
        _, out, _ = self._runs[run_id]
        if self.gate is not None:
            await self.gate.wait()
        if isinstance(out, list):
            for ev in out:
                if ev == "WAIT":
                    await self.release.wait()
                else:
                    yield ev
            return
        yield {"type": "tool.started", "id": "t1", "name": "terminal"}
        yield {"type": "message.delta", "text": out}
        yield {"type": "run.completed"}

    async def run_status(self, agent, run_id):
        return self.status

    async def stop(self, agent, run_id):
        self.stopped.append(run_id)
        self.release.set()
        if self.gate is not None:
            self.gate.set()

    async def rename_session(self, agent, session_id, title):
        self.titles.append((agent, session_id, title))


def make_engine(script, agents=("anna", "bert"), store=None):
    adapter = FakeAdapter(script)
    targets = {a: SimpleNamespace(agent=SimpleNamespace(id=a, label=a.capitalize()), adapter=adapter) for a in agents}
    engine = RoomEngine(store or RoomStore(":memory:"), lambda host, runtime, agent: targets.get(agent))
    room = engine.store.create("Test", [{"host": "h", "runtime": "hermes", "agent": a} for a in agents], "u")
    return engine, adapter, room["id"]


async def settle(engine, rid, timeout=5.0):
    turn = engine.turns.get(rid)
    if turn and turn.task:
        await asyncio.wait_for(turn.task, timeout)
    return turn


def authors(engine, rid):
    return [(m["author"].split("/")[-1], m["text"]) for m in engine.store.messages(rid) if m["kind"] == "message"]


# --- reine Hilfen --------------------------------------------------------------------------------
NAMES = {"anna": "h/hermes/anna", "bert": "h/hermes/bert"}


def test_mentions_in_order_of_appearance_without_duplicates():
    assert parse_mentions("@Bert und @anna, dann nochmal @bert", NAMES) == ["h/hermes/bert", "h/hermes/anna"]


def test_mentions_all_and_user_are_reserved_words():
    assert parse_mentions("@all bitte, @user wartet", NAMES) == ["all", "user"]
    assert parse_mentions("@alle", NAMES) == ["all"]


def test_mentions_ignore_unknown_names_and_mail_addresses():
    assert parse_mentions("@niemand und a@anna.de", NAMES) == []


def test_mentions_cope_with_trailing_punctuation():
    assert parse_mentions("Danke @bert!", NAMES) == ["h/hermes/bert"]


def test_mentions_read_umlauts_and_trailing_honorifics():
    names = {"jörg": "h/hermes/joerg", "eta": "h/hermes/eta"}
    assert parse_mentions("@Jörg, schau mal", names) == ["h/hermes/joerg"]
    assert parse_mentions("@Eta-san bitte, oder @eta_bot", names) == ["h/hermes/eta"]
    assert parse_mentions("@user-feedback", names) == []  # Reservierte Wörter werden nicht aus Anhängseln erraten
    assert parse_mentions("@all-hands", names) == []


def test_pass_is_recognised_loosely():
    assert is_pass("[PASS]") and is_pass("  [pass] nichts zu sagen") and not is_pass("Ich passe nicht")


def test_prompt_names_the_rules_and_the_new_messages():
    fresh = [{"author": "user", "text": "Hallo zusammen"}, {"author": "h/hermes/bert", "text": "Moin"}]
    p = build_prompt("Rat", "Anna", ["Bert"], fresh, NAMES)
    assert "„Anna“" in p and "„Rat“" in p and "Bert" in p
    assert "[PASS]" in p and "@user" in p and "@Name" in p
    assert "Person: Hallo zusammen" in p and "bert: Moin" in p


def test_prompt_tells_a_member_who_is_addressed_to_answer():
    fresh = [{"author": "user", "text": "@Anna, wie sieht es aus?"}]
    asked = build_prompt("Rat", "Anna", ["Bert"], fresh, NAMES, addressed=True)
    assert "direkt angesprochen" in asked and "Antworte darauf" in asked
    assert "direkt angesprochen" not in build_prompt("Rat", "Anna", ["Bert"], fresh, NAMES)
    assert "antworte immer" in build_prompt("Rat", "Anna", ["Bert"], fresh, NAMES)  # die Regel steht für alle da


# --- Speicher ------------------------------------------------------------------------------------
def test_store_numbers_messages_per_room_and_pages_by_seq():
    s = RoomStore(":memory:")
    a = s.create("A", [{"host": "h", "runtime": "r", "agent": "x"}], "u")["id"]
    b = s.create("B", [{"host": "h", "runtime": "r", "agent": "x"}], "u")["id"]
    assert [s.add_message(a, "user", "message", f"m{i}")["seq"] for i in range(3)] == [1, 2, 3]
    assert s.add_message(b, "user", "message", "x")["seq"] == 1
    assert [m["text"] for m in s.messages(a, after=1)] == ["m1", "m2"]
    assert s.last_seq(a) == 3


def test_store_survives_a_restart(tmp_path):
    path = tmp_path / "sub" / "rooms.db"
    rid = RoomStore(path).create("R", [{"host": "h", "runtime": "r", "agent": "x"}], "u")["id"]
    again = RoomStore(path)
    assert again.get(rid)["name"] == "R"


def test_store_update_rejects_unknown_columns():
    s = RoomStore(":memory:")
    rid = s.create("A", [], "u")["id"]
    with pytest.raises(ValueError):
        s.update(rid, owner="evil")


# --- Ablauf --------------------------------------------------------------------------------------
async def test_without_mention_everyone_answers_once_and_the_room_rests():
    engine, adapter, rid = make_engine(lambda agent, prompt, n: f"Antwort von {agent}")
    await engine.send(rid, "Hallo", "u")
    turn = await settle(engine, rid)
    assert authors(engine, rid) == [("user", "Hallo"), ("anna", "Antwort von anna"), ("bert", "Antwort von bert")]
    assert turn.reason == "idle" and rid not in engine.turns
    room = engine.store.get(rid)
    assert room["sessions"] == {"h/hermes/anna": "sess-anna", "h/hermes/bert": "sess-bert"}
    assert room["cursors"]["h/hermes/anna"] == 1  # Anna hat die Nachricht der Person gesehen
    assert [t[2] for t in adapter.titles] == ["Gruppe: Test · Anna", "Gruppe: Test · Bert"]


async def test_a_mention_picks_the_speaker():
    engine, adapter, rid = make_engine(lambda agent, prompt, n: f"ok {agent}")
    await engine.send(rid, "@bert was meinst du?", "u")
    await settle(engine, rid)
    assert [a for a, *_ in adapter.calls] == ["bert"]


async def test_answers_chain_through_mentions_and_each_member_sees_only_what_is_new():
    def script(agent, prompt, n):
        if agent == "anna" and n == 1:
            return "Ich frage @bert: wie siehst du das?"
        return "Gut so."

    engine, adapter, rid = make_engine(script)
    await engine.send(rid, "@anna starte", "u")
    await settle(engine, rid)
    assert authors(engine, rid) == [("user", "@anna starte"), ("anna", "Ich frage @bert: wie siehst du das?"), ("bert", "Gut so.")]
    bert_prompt = next(p for a, p, *_ in adapter.calls if a == "bert")
    assert "Anna: Ich frage @bert" in bert_prompt and "Person: @anna starte" in bert_prompt
    anna_prompts = [p for a, p, *_ in adapter.calls if a == "anna"]
    assert len(anna_prompts) == 1  # Annas eigener Beitrag löst keinen weiteren Zug aus


async def test_a_second_message_only_brings_what_happened_since_the_members_last_turn():
    engine, adapter, rid = make_engine(lambda agent, prompt, n: f"{agent}-{n}")
    await engine.send(rid, "eins", "u")
    await settle(engine, rid)
    await engine.send(rid, "zwei", "u")
    await settle(engine, rid)
    second = [p for a, p, *_ in adapter.calls if a == "anna"][1]
    assert "Person: zwei" in second and "Person: eins" not in second
    assert "Bert: bert-1" in second  # der Beitrag des anderen kam dazwischen
    sessions = {c[0]: c[2] for c in adapter.calls[2:]}
    assert sessions["anna"] == "sess-anna"  # dieselbe Session wie im ersten Zug


async def test_at_most_three_rounds():
    engine, adapter, rid = make_engine(lambda agent, prompt, n: f"@{'bert' if agent == 'anna' else 'anna'} und du?")
    await engine.send(rid, "Los", "u")
    turn = await settle(engine, rid)
    assert turn.reason == "max_rounds"
    assert len(adapter.calls) == 6  # 3 Runden mit je zwei Zügen


async def test_at_most_ten_agent_messages_per_send():
    agents = ("a1", "a2", "a3", "a4")
    engine, adapter, rid = make_engine(lambda agent, prompt, n: "@all weiter", agents=agents)
    await engine.send(rid, "Los", "u")
    turn = await settle(engine, rid)
    assert turn.reason == "max_messages"
    assert len(adapter.calls) == MAX_AGENT_MESSAGES


async def test_pass_is_not_a_message_and_is_announced():
    engine, adapter, rid = make_engine(lambda agent, prompt, n: "[PASS]" if agent == "anna" else "Ich bin da.")
    q = engine.subscribe(rid)
    await engine.send(rid, "Hallo", "u")
    await settle(engine, rid)
    assert authors(engine, rid) == [("user", "Hallo"), ("bert", "Ich bin da.")]
    types = []
    while not q.empty():
        types.append(q.get_nowait()["type"])
    assert "member.passed" in types and types[0] == "message" and types[-1] == "turn.finished"
    assert {"turn.started", "member.started", "member.event"} <= set(types)


async def test_user_mention_holds_the_room_and_flags_it():
    engine, adapter, rid = make_engine(lambda agent, prompt, n: "@user darf ich das löschen?" if agent == "anna" else "Hm.")
    await engine.send(rid, "@anna räum auf", "u")
    turn = await settle(engine, rid)
    assert turn.reason == "needs_user"
    assert engine.store.get(rid)["needs_user"] is True
    await engine.send(rid, "Ja, bitte", "u")
    assert engine.store.get(rid)["needs_user"] is False  # die Antwort der Person erledigt das
    await settle(engine, rid)


async def test_a_member_mentioned_together_with_the_user_still_gets_its_turn():
    """Echter Fall aus Server: „@bert prüf das, ich fasse es für @user zusammen“ beendete den Raum, bevor Bert dran war."""
    def script(agent, prompt, n):
        if agent == "anna":
            return "@bert prüf das bitte, ich fasse es dann für @user zusammen." if n == 1 else "Danke Bert, dann fasse ich zusammen."
        return "@anna geprüft, passt."
    engine, adapter, rid = make_engine(script)
    await engine.send(rid, "@anna frag bert", "u")
    turn = await settle(engine, rid)
    assert authors(engine, rid) == [("user", "@anna frag bert"), ("anna", "@bert prüf das bitte, ich fasse es dann für @user zusammen."),
                                    ("bert", "@anna geprüft, passt."), ("anna", "Danke Bert, dann fasse ich zusammen.")]
    assert [c[0] for c in adapter.calls] == ["anna", "bert", "anna"]
    # Die Person wurde gerufen: der Raum bleibt markiert und meldet es als Grund des Endes.
    assert turn.reason == "needs_user" and engine.store.get(rid)["needs_user"] is True


async def test_the_user_alone_still_stops_the_room_at_once():
    engine, adapter, rid = make_engine(lambda agent, prompt, n: "@user und @bert, was meint ihr?" if agent == "anna" else "Ja.")
    await engine.send(rid, "@anna los", "u")
    await settle(engine, rid)
    assert [c[0] for c in adapter.calls] == ["anna", "bert"]  # bert war mit genannt, danach ist niemand mehr dran


def test_prompt_names_speakers_by_display_name_not_agent_id():
    names = {"eta": "h/hermes/default", "default": "h/hermes/default", "bert": "h/hermes/bert"}
    p = build_prompt("Raum", "Bert", ["Eta"], [{"author": "h/hermes/default", "text": "Hi"}], names, labels={"h/hermes/default": "Eta"})
    assert "Eta: Hi" in p and "default: Hi" not in p
    assert "eta: Hi" in build_prompt("Raum", "Bert", ["Eta"], [{"author": "h/hermes/default", "text": "Hi"}], names)  # ohne labels: Anzeigename, nie die Kennung


def test_prompt_asks_for_user_mentions_only_when_stuck():
    p = build_prompt("Raum", "anna", ["bert"], [{"author": "user", "text": "Hi"}], {"anna": "a", "bert": "b"})
    assert "nur, wenn du ohne Entscheidung der Person nicht weiterkommst" in p


async def test_a_failing_member_is_reported_and_the_others_still_answer():
    def script(agent, prompt, n):
        return UpstreamError(502, "Runtime nicht erreichbar") if agent == "anna" else "Ich antworte."

    engine, adapter, rid = make_engine(script)
    await engine.send(rid, "Hallo", "u")
    await settle(engine, rid)
    msgs = engine.store.messages(rid)
    assert any(m["kind"] == "system" and "Anna konnte nicht antworten" in m["text"] and "nicht erreichbar" in m["text"] for m in msgs)
    assert ("bert", "Ich antworte.") in authors(engine, rid)


async def test_sending_while_the_room_works_is_refused():
    engine, adapter, rid = make_engine(lambda agent, prompt, n: "ok")
    adapter.gate = asyncio.Event()
    await engine.send(rid, "Hallo", "u")
    with pytest.raises(RoomError) as e:
        await engine.send(rid, "noch eine", "u")
    assert e.value.status == 409
    adapter.gate.set()
    await settle(engine, rid)


async def test_stop_ends_the_turn_and_stops_the_running_agent():
    engine, adapter, rid = make_engine(lambda agent, prompt, n: "ok")
    adapter.gate = asyncio.Event()
    await engine.send(rid, "Hallo", "u")
    for _ in range(100):  # bis der erste Agent läuft
        await asyncio.sleep(0.01)
        if engine.turns[rid].current:
            break
    assert await engine.stop(rid) is True
    turn = await settle(engine, rid)
    assert turn.reason == "stopped" and adapter.stopped
    assert len(adapter.calls) == 1  # der zweite kommt nicht mehr dran
    assert await engine.stop(rid) is False


async def test_archived_rooms_and_missing_members_refuse_new_messages():
    engine, adapter, rid = make_engine(lambda agent, prompt, n: "ok")
    engine.store.update(rid, archived=True)
    with pytest.raises(RoomError):
        await engine.send(rid, "Hallo", "u")
    engine.store.update(rid, archived=False)
    engine._targets = lambda host, runtime, agent: None  # Agent steht nicht mehr in der hosts.json
    with pytest.raises(RoomError) as e:
        await engine.send(rid, "Hallo", "u")
    assert "nicht mehr in der Konfiguration" in e.value.detail


async def test_the_idempotency_key_differs_per_member_and_per_trigger():
    engine, adapter, rid = make_engine(lambda agent, prompt, n: "ok")
    await engine.send(rid, "eins", "u")
    await settle(engine, rid)
    await engine.send(rid, "zwei", "u")
    await settle(engine, rid)
    keys = [c[3] for c in adapter.calls]
    assert len(set(keys)) == 4 and all(k.startswith(f"room-{rid}-") for k in keys)


# --- Offene Fragen, leere Antworten ---------------------------------------------------------------------
APPROVAL = {"type": "approval.requested", "command": "rm -rf build", "reason": "löscht Dateien", "choices": ["once", "deny"], "timeout_s": 300}
CLARIFY = {"type": "clarify.requested", "clarify_id": "c1", "question": "Welche Datei?", "choices": ["a", "b"]}
DONE = {"type": "run.completed"}


async def until(predicate, timeout=3.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("Bedingung trat nicht ein")


async def test_an_approval_is_held_by_the_server_while_the_run_waits():
    script = lambda agent, prompt, n: [APPROVAL, "WAIT", {"type": "approval.responded", "choice": "once", "resolved": True},
                                       {"type": "message.delta", "text": "Erledigt."}, DONE] if agent == "anna" else "[PASS]"
    engine, adapter, rid = make_engine(script)
    q = engine.subscribe(rid)
    await engine.send(rid, "@anna räum auf", "u")
    await until(lambda: engine.open_asks(rid))
    (ask,) = engine.open_asks(rid)
    assert ask["kind"] == "approval" and ask["member"] == "h/hermes/anna" and ask["run_id"] == "run-1"
    assert ask["command"] == "rm -rf build" and ask["choices"] == ["once", "deny"]
    assert engine.status(rid)["asks"] == [ask]  # wer den Raum später öffnet, bekommt sie mit dem Zustand
    adapter.release.set()
    await settle(engine, rid)
    assert engine.open_asks(rid) == [] and rid not in engine.asks
    assert ("anna", "Erledigt.") in authors(engine, rid)
    seen = []
    while not q.empty():
        ev = q.get_nowait()
        if ev["type"] == "asks":
            seen.append(len(ev["asks"]))
    assert seen == [1, 0]  # erst erschienen, dann erledigt


async def test_a_clarification_is_held_until_the_run_goes_on():
    script = lambda agent, prompt, n: [CLARIFY, "WAIT", {"type": "message.delta", "text": "Dann a."}, DONE]
    engine, adapter, rid = make_engine(script, agents=("anna", "bert"))
    await engine.send(rid, "@anna mach was", "u")
    await until(lambda: engine.open_asks(rid))
    (ask,) = engine.open_asks(rid)
    assert ask["kind"] == "clarify" and ask["question"] == "Welche Datei?" and ask["clarify_id"] == "c1" and ask["choices"] == ["a", "b"]
    adapter.release.set()
    await settle(engine, rid)
    assert engine.open_asks(rid) == []


async def test_asks_vanish_with_a_stopped_run_and_never_linger():
    engine, adapter, rid = make_engine(lambda agent, prompt, n: [APPROVAL, "WAIT", {"type": "run.stopped"}])
    await engine.send(rid, "@anna los", "u")
    await until(lambda: engine.open_asks(rid))
    assert await engine.stop(rid) is True
    await settle(engine, rid)
    assert engine.open_asks(rid) == [] and rid not in engine.asks


async def test_asks_of_different_rooms_and_members_stay_apart():
    engine, adapter, rid = make_engine(lambda agent, prompt, n: [APPROVAL, "WAIT", DONE])
    other = engine.store.create("Zweiter", [{"host": "h", "runtime": "hermes", "agent": a} for a in ("anna", "bert")], "u")["id"]
    await engine.send(rid, "hallo", "u")
    await until(lambda: len(engine.open_asks(rid)) == 1)
    assert engine.open_asks(other) == []
    adapter.release.set()
    await settle(engine, rid)


async def test_an_empty_run_is_announced_instead_of_vanishing():
    engine, adapter, rid = make_engine(lambda agent, prompt, n: [DONE] if agent == "anna" else "Ich bin da.")
    adapter.status = {"error": {"message": "Kein API-Key für anthropic"}}
    await engine.send(rid, "Hallo", "u")
    await settle(engine, rid)
    notes = [m["text"] for m in engine.store.messages(rid) if m["kind"] == "system"]
    assert len(notes) == 1 and "Anna hat nichts geantwortet" in notes[0] and "Kein API-Key für anthropic" in notes[0]
    assert ("bert", "Ich bin da.") in authors(engine, rid)


async def test_an_empty_run_without_a_reason_still_says_so():
    engine, adapter, rid = make_engine(lambda agent, prompt, n: [DONE])
    await engine.send(rid, "@anna ?", "u")
    await settle(engine, rid)
    (note,) = [m["text"] for m in engine.store.messages(rid) if m["kind"] == "system"]
    assert note == "Anna hat nichts geantwortet: Hermes lieferte einen leeren Lauf."


async def test_passing_when_addressed_is_announced_but_passing_unasked_is_not():
    engine, adapter, rid = make_engine(lambda agent, prompt, n: "[PASS]")
    await engine.send(rid, "@anna bist du da?", "u")
    await settle(engine, rid)
    notes = [m["text"] for m in engine.store.messages(rid) if m["kind"] == "system"]
    assert notes == ["Anna wurde angesprochen und hat mit [PASS] übergangen."]
    engine2, _, rid2 = make_engine(lambda agent, prompt, n: "[PASS]")
    await engine2.send(rid2, "Hallo in die Runde", "u")
    await settle(engine2, rid2)
    assert [m for m in engine2.store.messages(rid2) if m["kind"] == "system"] == []


async def test_the_addressed_member_is_told_to_answer_the_others_are_not():
    engine, adapter, rid = make_engine(lambda agent, prompt, n: "ok")
    await engine.send(rid, "@anna und @bert, kurz bitte", "u")
    await settle(engine, rid)
    assert all("direkt angesprochen" in c[1] for c in adapter.calls)
    engine2, adapter2, rid2 = make_engine(lambda agent, prompt, n: "ok")
    await engine2.send(rid2, "Hallo zusammen", "u")
    await settle(engine2, rid2)
    assert all("direkt angesprochen" not in c[1] for c in adapter2.calls)


async def test_the_answer_comes_from_the_final_message_or_the_interim_ones_when_there_is_no_stream():
    final = {"type": "run.completed", "text": "Fertig."}
    engine, adapter, rid = make_engine(lambda agent, prompt, n: [final] if agent == "anna" else [{"type": "message.interim", "text": "Ich schaue nach."}, DONE])
    await engine.send(rid, "Hallo", "u")
    await settle(engine, rid)
    assert authors(engine, rid) == [("user", "Hallo"), ("anna", "Fertig."), ("bert", "Ich schaue nach.")]


async def test_a_run_that_breaks_off_keeps_its_text_and_says_so():
    engine, adapter, rid = make_engine(lambda agent, prompt, n: [{"type": "message.delta", "text": "Halber Gedanke"}, {"type": "run.failed", "error": "Zeitüberschreitung beim Anbieter"}])
    await engine.send(rid, "@anna erzähl", "u")
    await settle(engine, rid)
    assert ("anna", "Halber Gedanke") in authors(engine, rid)
    (note,) = [m["text"] for m in engine.store.messages(rid) if m["kind"] == "system"]
    assert "vorzeitig" in note and "Zeitüberschreitung beim Anbieter" in note


async def test_a_mention_with_an_honorific_still_hands_over_to_the_member():
    engine, adapter, rid = make_engine(lambda agent, prompt, n: "@Bert-san, deine Meinung?" if agent == "anna" else "Meine Meinung: gut.")
    await engine.send(rid, "@anna frag @bert", "u")
    await settle(engine, rid)
    assert [a for a, _ in authors(engine, rid)] == ["user", "anna", "bert"]


# --- Routen --------------------------------------------------------------------------------------
@pytest.fixture
def client(make_settings, tmp_path):
    transport = RouterTransport({"hermes.test": httpx.ASGITransport(app=create_mock(wait_for_user=False, delay=0, profiles=("default", "beta", "eta")))})
    with TestClient(create_app(make_settings(rooms_db=tmp_path / "rooms.db"), transport=transport)) as c:
        c.headers.update(HDR)
        yield c


M = [{"host": "server", "runtime": "hermes", "agent": "default"}, {"host": "server", "runtime": "hermes", "agent": "beta"}]


def wait_idle(client, rid, timeout=10.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        room = client.get(f"/bff/rooms/{rid}").json()
        if not room["running"]:
            return room
        time.sleep(0.05)
    raise AssertionError("Raum wurde nicht ruhig")


def test_a_room_through_the_api_with_real_agents_from_the_mock(client):
    r = client.post("/bff/rooms", json={"name": "Runde", "members": M})
    assert r.status_code == 201
    room = r.json()
    assert [m["key"] for m in room["members"]] == ["server/hermes/default", "server/hermes/beta"]
    rid = room["id"]
    assert client.post(f"/bff/rooms/{rid}/messages", json={"text": "Hallo ihr zwei"}).status_code == 202
    done = wait_idle(client, rid)
    texts = [(m["author"], m["kind"]) for m in done["messages"]]
    assert texts == [("user", "message"), ("server/hermes/default", "message"), ("server/hermes/beta", "message")]
    assert "Mock-Antwort" in done["messages"][1]["text"]
    listed = client.get("/bff/rooms").json()["rooms"]
    assert [r["id"] for r in listed] == [rid] and listed[0]["last_message"]["author"] == "server/hermes/beta"


def test_room_input_is_validated(client):
    one = client.post("/bff/rooms", json={"name": "x", "members": M[:1]})
    assert one.status_code == 422
    dup = client.post("/bff/rooms", json={"name": "x", "members": [M[0], M[0]]})
    assert dup.status_code == 422 and "nur einmal" in dup.json()["detail"]
    unknown = client.post("/bff/rooms", json={"name": "x", "members": [M[0], {"host": "server", "runtime": "hermes", "agent": "geist"}]})
    assert unknown.status_code == 404
    evil = client.post("/bff/rooms", json={"name": "x", "members": [M[0], {"host": "server", "runtime": "hermes", "agent": "../etc"}]})
    assert evil.status_code == 422
    assert client.post("/bff/rooms", json={"name": "", "members": M}).status_code == 422
    seven = client.post("/bff/rooms", json={"name": "x", "members": [{"host": "server", "runtime": "hermes", "agent": f"a{i}"} for i in range(7)]})
    assert seven.status_code == 422


def test_unknown_room_ids_are_rejected_before_any_lookup(client):
    assert client.get("/bff/rooms/zzzzzzzzzzzz").status_code == 422
    assert client.get("/bff/rooms/000000000000").status_code == 404
    assert client.post("/bff/rooms/000000000000/messages", json={"text": "x"}).status_code == 404


def test_rename_and_archive_but_never_delete(client):
    rid = client.post("/bff/rooms", json={"name": "Alt", "members": M}).json()["id"]
    assert client.patch(f"/bff/rooms/{rid}", json={"name": "Neu"}).json()["name"] == "Neu"
    assert client.patch(f"/bff/rooms/{rid}", json={"archived": True}).json()["archived"] is True
    assert client.get("/bff/rooms").json()["rooms"] == []
    assert [r["id"] for r in client.get("/bff/rooms?archived=true").json()["rooms"]] == [rid]
    assert client.delete(f"/bff/rooms/{rid}").status_code == 405
    assert client.post(f"/bff/rooms/{rid}/messages", json={"text": "x"}).status_code == 409


def test_messages_are_audited_without_their_text(client, tmp_path):
    rid = client.post("/bff/rooms", json={"name": "Runde", "members": M}).json()["id"]
    client.post(f"/bff/rooms/{rid}/messages", json={"text": "GEHEIMER-INHALT"})
    wait_idle(client, rid)
    log = (tmp_path / "audit.log").read_text()
    assert "room.message" in log and "GEHEIMER-INHALT" not in log


def test_the_event_stream_starts_with_the_room_state(client):
    rid = client.post("/bff/rooms", json={"name": "Runde", "members": M}).json()["id"]
    with client.stream("GET", f"/bff/rooms/{rid}/events") as r:
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
        first = next(line for line in r.iter_lines() if line.startswith("data:"))
    assert '"type": "state"' in first and '"running": false' in first


def test_open_asks_are_part_of_the_room_the_list_and_the_stream_state(client):
    rid = client.post("/bff/rooms", json={"name": "Runde", "members": M}).json()["id"]
    assert client.get(f"/bff/rooms/{rid}").json()["asks"] == []
    client.app.state.rooms.engine._track_ask(rid, "server/hermes/default", "run-9", APPROVAL)
    room = client.get(f"/bff/rooms/{rid}").json()
    assert [(a["run_id"], a["kind"], a["command"]) for a in room["asks"]] == [("run-9", "approval", "rm -rf build")]
    assert client.get("/bff/rooms").json()["rooms"][0]["asks"] == room["asks"]
    with client.stream("GET", f"/bff/rooms/{rid}/events") as r:
        first = next(line for line in r.iter_lines() if line.startswith("data:"))
    assert '"asks": [{"kind": "approval"' in first  # wer sich neu verbindet, sieht die offene Freigabe sofort


def test_an_unwritable_store_only_takes_the_rooms_down(make_settings, tmp_path):
    blocker = tmp_path / "datei"
    blocker.write_text("x")  # ein Ordner kann hier nicht angelegt werden
    transport = RouterTransport({"hermes.test": httpx.ASGITransport(app=create_mock())})
    with TestClient(create_app(make_settings(rooms_db=blocker / "rooms.db"), transport=transport)) as c:
        c.headers.update(HDR)
        assert c.get("/bff/rooms").status_code == 503
        assert c.get("/bff/hosts").status_code == 200
