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
    """Agent, dessen Antwort ein Skript bestimmt: script(agent, prompt, nth) -> Text oder Exception."""

    def __init__(self, script):
        self.script, self.calls, self.stopped, self.titles, self.gate = script, [], [], [], None
        self._runs: dict[str, tuple[str, str, int]] = {}

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
        _, text, _ = self._runs[run_id]
        if self.gate is not None:
            await self.gate.wait()
        yield {"type": "tool.started", "id": "t1", "name": "terminal"}
        yield {"type": "message.delta", "text": text}
        yield {"type": "run.completed"}

    async def stop(self, agent, run_id):
        self.stopped.append(run_id)
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


def test_pass_is_recognised_loosely():
    assert is_pass("[PASS]") and is_pass("  [pass] nichts zu sagen") and not is_pass("Ich passe nicht")


def test_prompt_names_the_rules_and_the_new_messages():
    fresh = [{"author": "user", "text": "Hallo zusammen"}, {"author": "h/hermes/bert", "text": "Moin"}]
    p = build_prompt("Rat", "Anna", ["Bert"], fresh, NAMES)
    assert "„Anna“" in p and "„Rat“" in p and "Bert" in p
    assert "[PASS]" in p and "@user" in p and "@Name" in p
    assert "Person: Hallo zusammen" in p and "bert: Moin" in p


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
    assert "anna: Ich frage @bert" in bert_prompt and "Person: @anna starte" in bert_prompt
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
    assert "bert: bert-1" in second  # der Beitrag des anderen kam dazwischen
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


# --- Routen --------------------------------------------------------------------------------------
@pytest.fixture
def client(make_settings, tmp_path):
    transport = RouterTransport({"hermes.test": httpx.ASGITransport(app=create_mock(wait_for_user=False, delay=0, profiles=("default", "omoikane", "sora")))})
    with TestClient(create_app(make_settings(rooms_db=tmp_path / "rooms.db"), transport=transport)) as c:
        c.headers.update(HDR)
        yield c


M = [{"host": "hikari", "runtime": "hermes", "agent": "default"}, {"host": "hikari", "runtime": "hermes", "agent": "omoikane"}]


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
    assert [m["key"] for m in room["members"]] == ["hikari/hermes/default", "hikari/hermes/omoikane"]
    rid = room["id"]
    assert client.post(f"/bff/rooms/{rid}/messages", json={"text": "Hallo ihr zwei"}).status_code == 202
    done = wait_idle(client, rid)
    texts = [(m["author"], m["kind"]) for m in done["messages"]]
    assert texts == [("user", "message"), ("hikari/hermes/default", "message"), ("hikari/hermes/omoikane", "message")]
    assert "Mock-Antwort" in done["messages"][1]["text"]
    listed = client.get("/bff/rooms").json()["rooms"]
    assert [r["id"] for r in listed] == [rid] and listed[0]["last_message"]["author"] == "hikari/hermes/omoikane"


def test_room_input_is_validated(client):
    one = client.post("/bff/rooms", json={"name": "x", "members": M[:1]})
    assert one.status_code == 422
    dup = client.post("/bff/rooms", json={"name": "x", "members": [M[0], M[0]]})
    assert dup.status_code == 422 and "nur einmal" in dup.json()["detail"]
    unknown = client.post("/bff/rooms", json={"name": "x", "members": [M[0], {"host": "hikari", "runtime": "hermes", "agent": "geist"}]})
    assert unknown.status_code == 404
    evil = client.post("/bff/rooms", json={"name": "x", "members": [M[0], {"host": "hikari", "runtime": "hermes", "agent": "../etc"}]})
    assert evil.status_code == 422
    assert client.post("/bff/rooms", json={"name": "", "members": M}).status_code == 422
    seven = client.post("/bff/rooms", json={"name": "x", "members": [{"host": "hikari", "runtime": "hermes", "agent": f"a{i}"} for i in range(7)]})
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


def test_an_unwritable_store_only_takes_the_rooms_down(make_settings, tmp_path):
    blocker = tmp_path / "datei"
    blocker.write_text("x")  # ein Ordner kann hier nicht angelegt werden
    transport = RouterTransport({"hermes.test": httpx.ASGITransport(app=create_mock())})
    with TestClient(create_app(make_settings(rooms_db=blocker / "rooms.db"), transport=transport)) as c:
        c.headers.update(HDR)
        assert c.get("/bff/rooms").status_code == 503
        assert c.get("/bff/hosts").status_code == 200
