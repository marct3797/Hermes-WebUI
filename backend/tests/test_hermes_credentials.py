"""Schlüssel-Pools (Punkt 8): mehrere Schlüssel je Anbieter, damit Hermes bei Limits wechseln kann.

Schranken des BFF:
- Hinzufügen/Entfernen nur mit frischer Anmeldung; der Schlüssel ist write-only (nie in Antwort, Liste oder Audit),
- die Liste zeigt höchstens die letzten vier Zeichen,
- Entfernen nur von Hand angelegter Einträge und nur mit eingetipptem Anbieternamen (Einträge aus .env/OAuth räumt Hermes am Ursprung auf: Sache der CLI),
- jede Änderung wird über die Zahl der Einträge zurückgelesen.
"""
import pytest

from tests.denv import BASE, client, fresh, stale

C = f"{BASE}/hermes-credentials"
KEY = "sk-pool-geheim-123456789"


def entry(i, source="manual", preview="sk-p…6789"):
    return {"index": i, "id": f"id{i}", "label": f"key #{i}", "auth_type": "api_key", "source": source, "priority": 0, "last_status": None,
            "request_count": 3, "token_preview": preview, "has_refresh": False}


@pytest.fixture
def env(tmp_path, make_settings):
    yield from client(tmp_path, make_settings)


@pytest.fixture
def lossy(tmp_path, make_settings):
    yield from client(tmp_path, make_settings, drop_writes=True)


def seed(c, entries=None):
    c.dash.state.profiles["default"]["pool"] = {"openrouter": entries if entries is not None else [entry(1), entry(2, source="env:OPENROUTER_API_KEY")]}


def test_list_shows_entries_with_at_most_four_characters_of_the_key(env):
    seed(env)
    r = env.get(C)
    assert r.status_code == 200 and r.json()["providers"][0]["provider"] == "openrouter" and len(r.json()["providers"][0]["entries"]) == 2
    assert all(len(e["token_tail"]) <= 4 for e in r.json()["providers"][0]["entries"]) and "token_preview" not in r.text


def test_list_survives_an_install_without_any_pool(env):
    assert env.get(C).json() == {"providers": []}


@pytest.mark.parametrize("bad", [{"provider": "Open Router"}, {"provider": ""}, {"api_key": "kurz"}, {"api_key": "x" * 5001}, {"label": "l" * 61}, {"extra": 1}])
def test_add_rejects_malformed_input(env, bad):
    seed(env)
    r = env.post(C, json={"provider": "openrouter", "api_key": KEY, **bad})
    assert r.status_code == 422, (bad, r.text)
    assert len(env.get(C).json()["providers"][0]["entries"]) == 2


def test_add_needs_fresh_keeps_the_key_secret_and_reads_back(env):
    seed(env)
    stale(env)
    assert env.post(C, json={"provider": "openrouter", "api_key": KEY}).status_code == 401
    fresh(env)
    r = env.post(C, json={"provider": "openrouter", "api_key": KEY, "label": "Team"})
    assert r.status_code == 200 and r.json()["count"] == 3 and KEY not in r.text
    assert KEY not in env.get(C).text and KEY not in env.audit_file.read_text()


def test_remove_needs_fresh_typed_provider_manual_source_and_reads_back(env):
    seed(env)
    stale(env)
    assert env.request("DELETE", f"{C}/openrouter/1", params={"confirm": "openrouter"}).status_code == 401
    fresh(env)
    assert env.request("DELETE", f"{C}/openrouter/1", params={"confirm": "falsch"}).status_code == 422
    assert env.request("DELETE", f"{C}/openrouter/1").status_code == 422
    assert env.request("DELETE", f"{C}/openrouter/0", params={"confirm": "openrouter"}).status_code == 422
    assert env.request("DELETE", f"{C}/openrouter/9", params={"confirm": "openrouter"}).status_code == 404
    assert env.request("DELETE", f"{C}/openrouter/2", params={"confirm": "openrouter"}).status_code == 422  # stammt aus .env: nur die CLI
    assert len(env.get(C).json()["providers"][0]["entries"]) == 2
    assert env.request("DELETE", f"{C}/openrouter/1", params={"confirm": "openrouter"}).status_code == 200
    assert len(env.get(C).json()["providers"][0]["entries"]) == 1


def test_dropped_writes_are_not_success(lossy):
    seed(lossy)
    assert lossy.post(C, json={"provider": "openrouter", "api_key": KEY}).status_code == 502
    assert lossy.request("DELETE", f"{C}/openrouter/1", params={"confirm": "openrouter"}).status_code == 502
