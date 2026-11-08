"""Delegation schreiben: Modellrouten und Profilrouten (Etappe 3). Schlüssel bleiben write-only, Fremdfelder bleiben erhalten."""
from app.auth import SESSION_COOKIE
from tests.test_hermes_endpoints import D, env, lossy, stale  # noqa: F401

REAL = "sk-echt-schnell-1234cdef"
NEW = "sk-neu-geheim-9999"
ROUTE = {"name": "schnell", "original_name": "schnell", "description": "flink", "provider": "custom", "model": "m1"}


def fresh(env):
    env.app.state.sessions.get(env.cookies.get(SESSION_COOKIE)).auth_time = env.app.state.sessions.now()


def put(env, **kw):
    body = {"options": [ROUTE], "default": "", "confirm": "default"}
    body.update(kw)
    return env.put(f"{D}/model-map", json=body)


def test_model_map_needs_fresh_login_and_typed_agent(env):
    stale(env)
    assert put(env).status_code == 401
    fresh(env)
    assert put(env, confirm="falsch").status_code == 422
    assert put(env).status_code == 200


def test_existing_key_and_foreign_fields_survive_a_save_without_a_key(env):
    r = put(env, options=[{**ROUTE, "description": "neu beschrieben"}])
    assert r.status_code == 200, r.text
    assert r.json()["options"][0]["has_api_key"] is True and REAL not in r.text
    got = env.get(D).json()["model_map"]["options"][0]
    assert got["description"] == "neu beschrieben" and got["has_api_key"] is True
    assert REAL not in env.get(D).text


def test_rename_keeps_key_and_new_key_is_write_only(env):
    r = put(env, options=[{**ROUTE, "name": "flott", "original_name": "schnell"}])
    assert r.status_code == 200 and r.json()["options"][0]["has_api_key"] is True
    r = put(env, options=[{**ROUTE, "name": "flott", "original_name": "flott", "api_key": NEW}])
    assert r.status_code == 200 and NEW not in r.text and NEW not in env.get(D).text
    r = put(env, options=[{**ROUTE, "name": "flott", "original_name": "flott", "clear_api_key": True}])
    assert r.json()["options"][0]["has_api_key"] is False


def test_model_map_rejects_duplicates_unknown_default_and_extra_fields(env):
    assert put(env, options=[ROUTE, ROUTE]).status_code == 422
    assert put(env, default="gibt-es-nicht").status_code == 422
    assert put(env, options=[{**ROUTE, "base_url": "http://169.254.169.254/x"}]).status_code == 422
    assert put(env, options=[{**ROUTE, "request_overrides": {"a": 1}}]).status_code == 422


def test_model_map_is_read_back_and_audited_without_content(env, lossy):
    assert put(lossy, options=[{**ROUTE, "name": "zweite", "original_name": ""}]).status_code == 502
    r = put(env, options=[{**ROUTE, "api_key": NEW}], default="schnell")
    assert r.status_code == 200
    text = open(env.audit_file).read()
    assert "delegation.model_map" in text and NEW not in text and "flink" not in text and "m1" not in text


def test_profile_routes_validate_and_read_back(env, lossy):
    pr = lambda c, **kw: c.put(f"{D}/profile-routes", json={"profiles": [{"name": "beta", "description": "hilft"}], "default": "beta", "confirm": "default", **kw})
    assert pr(env, confirm="x").status_code == 422
    assert pr(env, profiles=[{"name": "gibt-es-nicht"}]).status_code == 422
    assert pr(env, profiles=[{"name": "beta"}, {"name": "beta"}]).status_code == 422
    assert pr(env, default="default").status_code == 422
    r = pr(env)
    assert r.status_code == 200 and r.json()["profiles"][0]["name"] == "beta" and r.json()["default"] == "beta"
    assert pr(lossy).status_code == 502


def test_read_gives_only_the_fields_of_the_form_with_defaults(env):
    env.dash.state.profiles["default"]["profile_routes"] = {"profiles": [{"name": "beta", "description": "hilft", "has_api_key": False, "secret_extra": "geheim-extra"}], "default": None}
    env.dash.state.profiles["default"]["model_map"] = {"options": [{"name": "nururl", "description": "d", "model": "m", "base_url": "http://127.0.0.1:1/v1", "request_overrides": {"headers": {"Authorization": "Bearer geheim-header"}}}], "default": None, "_keys": {}}
    r = env.get(D)
    assert "geheim-extra" not in r.text and "geheim-header" not in r.text
    assert r.json()["profile_routes"]["profiles"] == [{"name": "beta", "description": "hilft"}]
    assert r.json()["model_map"]["options"][0]["provider"] == "" and r.json()["model_map"]["options"][0]["reasoning_effort"] == ""
    # was die Maske liest, lässt sich unverändert wieder speichern
    ok = env.put(f"{D}/profile-routes", json={"profiles": r.json()["profile_routes"]["profiles"], "default": "", "confirm": "default"})
    assert ok.status_code == 200, ok.text


def test_a_stored_key_does_not_follow_a_changed_target(env):
    moved = {**ROUTE, "base_url": "https://angreifer.example/v1"}
    r = put(env, options=[moved])
    assert r.status_code == 422 and "Schlüssel" in r.json()["detail"]
    assert put(env, options=[{**moved, "api_key": NEW}]).status_code == 200  # neuer Schlüssel: erlaubt
    assert put(env, options=[{**moved, "original_name": "schnell", "clear_api_key": True}]).status_code == 200


def test_values_hermes_allows_are_not_blocked_here(env):
    assert put(env, options=[{**ROUTE, "reasoning_effort": "max", "service_tier": "priority"}]).status_code == 200
    assert put(env, options=[{**ROUTE, "reasoning_effort": "mit Leerzeichen!"}]).status_code == 422
