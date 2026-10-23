import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.rooms import RoomStore, RoomEngine
from app.routes.rooms import router, engine_of
from app.auth import current_user


@pytest.fixture
def room_api():
    store = RoomStore(":memory:")
    rid = store.create("Long", [], "test")["id"]
    for n in range(605):
        store.add_message(rid, "user", "message", str(n + 1))
    engine = RoomEngine(store, lambda *args: None)
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[current_user] = lambda: None
    app.dependency_overrides[engine_of] = lambda: engine
    with TestClient(app) as client:
        yield client, store, rid


def test_latest_backwards_and_incremental_pages(room_api):
    client, store, rid = room_api
    url = f"/bff/rooms/{rid}"
    latest = client.get(url).json()
    assert [m["seq"] for m in latest["messages"]] == list(range(406, 606))
    assert latest["has_older"] and not latest["has_more"]
    assert latest["next_after"] == 605 and latest["next_before"] == 406
    older = client.get(url, params={"before": latest["next_before"]}).json()
    assert [m["seq"] for m in older["messages"]] == list(range(206, 406))
    after, collected = 0, []
    while True:
        page = client.get(url, params={"after": after}).json()
        collected += [m["seq"] for m in page["messages"]]
        after = page["next_after"]
        if not page["has_more"]:
            break
    assert collected == list(range(1, 606))
    assert client.get(url, params={"after": 0, "before": 5}).status_code == 422


def test_member_cursor_cannot_advance_past_unread_messages():
    store = RoomStore(":memory:")
    rid = store.create("Long", [], "test")["id"]
    for n in range(605):
        store.add_message(rid, "user", "message", str(n))
    # Internal prompt reads must not inherit the public page-size limit.
    assert len(store.messages(rid, limit=None)) == 605


@pytest.mark.asyncio
async def test_member_prompt_contains_every_message_before_cursor_advance():
    from tests.test_rooms import make_engine
    from app.rooms import Turn
    engine, adapter, rid = make_engine(lambda *args: "[PASS]")
    for n in range(605):
        engine.store.add_message(rid, "user", "message", f"marker-{n:04d}")
    room = engine.store.get(rid)
    assert room is not None
    await engine._member_turn(Turn("test", rid), room, "h/hermes/anna", 1, engine.names(room))
    prompt = adapter.calls[0][1]
    assert all(f"marker-{n:04d}" in prompt for n in range(605))
    assert engine.store.get(rid)["cursors"]["h/hermes/anna"] == 605
