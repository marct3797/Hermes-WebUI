"""Team-Gateway: Konten verknüpfen und trennen (Etappe 3)."""
from app.auth import SESSION_COOKIE
from tests.test_hermes_endpoints import env, lossy, stale  # noqa: F401
from tests.conftest import BASE

R = f"{BASE}/messaging-relay"


def test_status_shows_accounts_without_extra_fields(env):
    r = env.get(R)
    assert r.status_code == 200, r.text
    row = r.json()["platforms"][0]
    assert row["platform"] == "telegram" and row["bot_url"] == "https://t.me/teambot"
    assert row["accounts"] == [{"id": "tg-4711", "label": "Marc", "linked_at": "2026-11-01T10:00:00Z"}]
    assert "geheim-relay-token" not in r.text


def test_link_code_needs_fresh_login_and_stays_out_of_the_audit(env):
    stale(env)
    assert env.post(f"{R}/telegram/link").status_code == 401
    env.app.state.sessions.get(env.cookies.get(SESSION_COOKIE)).auth_time = env.app.state.sessions.now()
    r = env.post(f"{R}/telegram/link")
    assert r.status_code == 200 and r.json()["command"] == f"/link {r.json()['code']}"
    assert env.get(f"{R}/link/{r.json()['code']}").json()["state"] == "pending"
    assert r.json()["code"] not in open(env.audit_file).read()
    refused = env.post(f"{R}/discord/link")  # Plattform nicht im Relay: der Fehlercode des Dashboards wird sichtbar
    assert refused.status_code == 502 and "409" in refused.json()["detail"]
    assert env.get(f"{R}/link/GIBTESNICHT").status_code == 404


def test_unlink_needs_the_word_and_is_read_back(env, lossy):
    assert env.delete(f"{R}/telegram/accounts/tg-4711").status_code == 422
    assert env.delete(f"{R}/telegram/accounts/tg-4711?confirm=trennen").status_code == 200
    assert env.get(R).json()["platforms"][0]["accounts"] == []
    assert lossy.delete(f"{R}/telegram/accounts/tg-4711?confirm=trennen").status_code == 502  # bleibt verknüpft


def test_unlink_cannot_smuggle_path_parts(env):
    for bad in ("..", ".", "x%3Fy%3D1", "a%2Fb", "x?y=1"):
        assert env.delete(f"{R}/telegram/accounts/{bad}?confirm=trennen").status_code in (404, 422), bad
    assert len(env.get(R).json()["platforms"][0]["accounts"]) == 1  # nichts getrennt


def test_unlink_audits_even_when_the_account_stays_linked(lossy):
    assert lossy.delete(f"{R}/telegram/accounts/tg-4711?confirm=trennen").status_code == 502
    assert "messaging.relay_unlink" in open(lossy.audit_file).read()
