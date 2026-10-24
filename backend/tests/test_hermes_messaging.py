"""Messaging-Plattformen und Gateway-Betrieb eines Hermes-Profils über das Dashboard.

Die Plattformen und ihre Variablen kommen vom Dashboard (Hermes kennt über 30). Geschrieben wird nur, was die Plattform selbst nennt;
Tokens werden nie zurückgegeben. Start, Stopp und Neustart des Gateways melden „gestartet“, nicht „läuft“, und unterbrechen laufende Sitzungen
nur nach ausdrücklicher Bestätigung.
"""
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import SESSION_COOKIE, User
from app.main import create_app
from devtools.mock_dashboard import create_mock as create_dashboard
from devtools.mock_hermes import create_mock
from tests.conftest import BASE, HDR, RouterTransport

M = f"{BASE}/messaging"
G = f"{BASE}/gateway"
TOKEN = "123456:ABC-sehr-geheimer-bot-token"


def build(tmp_path, make_settings, dash):
    f = tmp_path / "hosts.json"
    rt = {"id": "hermes", "base_url": "http://hermes.test", "api_key": "k", "multiplex": True, "agents": ["default", "beta"], "dashboard": {"base_url": "http://dash.test"}}
    f.write_text(json.dumps({"hosts": [{"id": "server", "runtimes": [rt]}]}))
    settings = make_settings(hosts_file=f, auth_mode="oidc", oidc_issuer="https://id.test", oidc_client_id="t", oidc_client_secret="t", oidc_allowed_sub="user", public_url="http://testserver")
    return create_app(settings, transport=RouterTransport({"hermes.test": httpx.ASGITransport(app=create_mock(delay=0)), "dash.test": httpx.ASGITransport(app=dash)})), settings


def logged_in(tmp_path, make_settings, dash):
    app, settings = build(tmp_path, make_settings, dash)
    with TestClient(app) as c:
        s = app.state.sessions.create(User("user", "Test"))
        s.auth_time = app.state.sessions.now()
        c.cookies.set(SESSION_COOKIE, s.id)
        c.headers.update(HDR)
        c.dash, c.audit_file = dash, settings.audit_file
        yield c


@pytest.fixture
def env(tmp_path, make_settings):
    yield from logged_in(tmp_path, make_settings, create_dashboard())


def platforms(c, path=M):
    return {p["id"]: p for p in c.get(path).json()["platforms"]}


def stale(c):
    c.app.state.sessions.get(c.cookies.get(SESSION_COOKIE)).auth_time = 0


# --- Plattformen ---------------------------------------------------------------------------------------
def test_list_shows_every_platform_the_dashboard_knows_with_its_state(env):
    p = platforms(env)
    assert set(p) == {"telegram", "discord", "whatsapp"}
    assert p["telegram"]["state"] == "disabled" and p["telegram"]["configured"] is False and p["telegram"]["name"] == "Telegram"
    assert [v["key"] for v in p["telegram"]["env_vars"]] == ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS"]


def test_list_never_carries_a_token_and_shows_plain_values_only_for_non_secrets(env):
    env.put(f"{M}/telegram", json={"enabled": True, "env": {"TELEGRAM_BOT_TOKEN": TOKEN, "TELEGRAM_ALLOWED_USERS": "111,222"}})
    text = env.get(M).text
    assert TOKEN not in text and TOKEN[:6] not in text and "redacted" not in text
    v = {x["key"]: x for x in platforms(env)["telegram"]["env_vars"]}
    assert v["TELEGRAM_BOT_TOKEN"]["is_set"] is True and v["TELEGRAM_BOT_TOKEN"]["is_password"] is True and "value" not in v["TELEGRAM_BOT_TOKEN"] and "redacted_value" not in v["TELEGRAM_BOT_TOKEN"]
    assert v["TELEGRAM_ALLOWED_USERS"]["value"] == "111,222" and v["TELEGRAM_ALLOWED_USERS"]["is_list"] is True


def test_list_leaves_out_server_paths_and_redacts_error_texts(env):
    env.put(f"{M}/discord", json={"enabled": True, "env": {"DISCORD_BOT_TOKEN": TOKEN}})
    body = env.get(M).json()
    assert "env_path" not in body and "/home/" not in json.dumps(body)
    discord = next(p for p in body["platforms"] if p["id"] == "discord")
    assert "hunter2" not in json.dumps(body) and discord["error_message"] == "[redacted]"
    assert next(v for v in discord["env_vars"] if v["key"] == "DISCORD_BOT_TOKEN")["prompt"] == "Bot token"  # Katalogtexte bleiben lesbar


def test_list_is_scoped_to_the_profile_and_unknown_profiles_are_rejected(env):
    env.put(f"{M}/telegram", json={"enabled": True, "env": {"TELEGRAM_BOT_TOKEN": TOKEN}})
    assert platforms(env)["telegram"]["enabled"] is True
    assert platforms(env, "/bff/h/server/hermes/beta/messaging")["telegram"]["enabled"] is False
    assert env.get("/bff/h/server/hermes/gamma/messaging").status_code == 404


def test_configuring_a_platform_stores_the_token_and_says_a_restart_is_needed(env):
    r = env.put(f"{M}/telegram", json={"enabled": True, "env": {"TELEGRAM_BOT_TOKEN": TOKEN, "TELEGRAM_ALLOWED_USERS": "111"}})
    assert r.status_code == 200 and r.json() == {"ok": True, "platform": "telegram", "needs_restart": True} and TOKEN not in r.text
    assert env.dash.state.profiles["default"]["env"]["TELEGRAM_BOT_TOKEN"] == TOKEN
    assert platforms(env)["telegram"]["configured"] is True and platforms(env)["telegram"]["state"] == "gateway_stopped"
    assert env.dash.state.gateway_calls == []  # Schreiben startet das Gateway nicht neu


def test_a_platform_can_be_switched_off_and_a_token_cleared(env):
    env.put(f"{M}/telegram", json={"enabled": True, "env": {"TELEGRAM_BOT_TOKEN": TOKEN}})
    r = env.put(f"{M}/telegram", json={"enabled": False, "clear_env": ["TELEGRAM_BOT_TOKEN"]})
    assert r.status_code == 200
    assert "TELEGRAM_BOT_TOKEN" not in env.dash.state.profiles["default"]["env"] and platforms(env)["telegram"]["enabled"] is False


def test_unknown_platform_is_a_404_and_other_variables_are_refused(env):
    assert env.put(f"{M}/gibtsnicht", json={"enabled": True}).status_code == 404
    for key in ("DISCORD_BOT_TOKEN", "PATH", "ANTHROPIC_API_KEY", "TERMINAL_SSH_HOST"):
        assert env.put(f"{M}/telegram", json={"env": {key: "x"}}).status_code == 422, key
        assert env.put(f"{M}/telegram", json={"clear_env": [key]}).status_code == 422, key
    assert "DISCORD_BOT_TOKEN" not in env.dash.state.profiles["default"]["env"] and env.dash.state.profiles["default"]["env"]["ANTHROPIC_API_KEY"] == "sk-ant-geheim-1234"


@pytest.mark.parametrize("value", ["«redacted:abcd...wxyz»", "***", "abcd...wxyz", "zwei\nzeilen", "x" * 5000])
def test_previews_and_malformed_values_are_not_stored(env, value):
    assert env.put(f"{M}/telegram", json={"env": {"TELEGRAM_BOT_TOKEN": value}}).status_code == 422
    assert "TELEGRAM_BOT_TOKEN" not in env.dash.state.profiles["default"]["env"]


def test_an_error_text_from_hermes_never_echoes_what_was_submitted(env):
    """Hermes nennt manchmal den abgelehnten Wert im Fehlertext. Das BFF schwärzt jeden gesendeten Wert, auch in verschachtelten Bodies."""
    r = env.put(f"{M}/telegram", json={"env": {"TELEGRAM_BOT_TOKEN": "echo:geheimer-wert-xyz"}})
    assert r.status_code == 502 and "geheimer-wert-xyz" not in r.text and "[REDACTED]" in r.text


def test_an_empty_value_keeps_the_stored_token(env):
    env.put(f"{M}/telegram", json={"env": {"TELEGRAM_BOT_TOKEN": TOKEN}})
    assert env.put(f"{M}/telegram", json={"env": {"TELEGRAM_BOT_TOKEN": " "}}).status_code == 200
    assert env.dash.state.profiles["default"]["env"]["TELEGRAM_BOT_TOKEN"] == TOKEN


def test_a_locked_env_file_is_reported_even_though_hermes_says_ok(env):
    """Hermes antwortet ok:true, wenn die .env gesperrt ist und nichts geschrieben wurde. Das BFF liest zurück."""
    env.dash.state.env_locked = True
    r = env.put(f"{M}/telegram", json={"env": {"TELEGRAM_BOT_TOKEN": TOKEN}})
    assert r.status_code == 502 and "TELEGRAM_BOT_TOKEN" in r.text and TOKEN not in r.text


def test_a_dashboard_that_drops_the_switch_is_reported(tmp_path, make_settings):
    for c in logged_in(tmp_path, make_settings, create_dashboard(drop_writes=True)):
        r = c.put(f"{M}/telegram", json={"enabled": True})
        assert r.status_code == 502 and "enabled" in r.text and "nicht übernommen" in r.text


def test_test_button_reads_the_state_without_changing_anything(env):
    env.put(f"{M}/telegram", json={"enabled": True, "env": {"TELEGRAM_BOT_TOKEN": TOKEN}})
    r = env.post(f"{M}/telegram/test")
    assert r.status_code == 200 and r.json()["ok"] is False and r.json()["state"] == "gateway_stopped" and TOKEN not in r.text


def test_changes_need_a_fresh_login_and_reading_does_not(env):
    stale(env)
    assert env.get(M).status_code == 200 and env.post(f"{M}/telegram/test").status_code == 200 and env.get(G).status_code == 200
    for method, path, body in [("PUT", f"{M}/telegram", {"enabled": True}), ("POST", f"{G}/start", {}), ("POST", f"{G}/stop", {}), ("POST", f"{G}/restart", {}),
                               ("POST", f"{M}/telegram/onboarding", {}), ("POST", f"{M}/telegram/onboarding/pair_abc123/apply", {"allowed_user_ids": ["1"]})]:
        r = env.request(method, path, json=body)
        assert r.status_code == 401 and r.json()["detail"]["code"] == "step_up_required", path
    assert env.dash.state.gateway_calls == [] and env.dash.state.pairings == {}


def test_audit_names_platform_and_keys_never_values(env):
    env.put(f"{M}/telegram", json={"enabled": True, "env": {"TELEGRAM_BOT_TOKEN": TOKEN, "TELEGRAM_ALLOWED_USERS": "999888777"}})
    env.put(f"{M}/telegram", json={"clear_env": ["TELEGRAM_ALLOWED_USERS"]})
    log = env.audit_file.read_text()
    assert "messaging.config" in log and "telegram" in log and "TELEGRAM_BOT_TOKEN" in log and TOKEN not in log and "999888777" not in log


def test_writes_are_rate_limited(env):
    env.app.state.limiter.per_minute = 4
    codes = [env.put(f"{M}/telegram", json={"enabled": bool(i % 2)}).status_code for i in range(8)]
    assert 429 in codes


def test_without_a_dashboard_the_page_gets_501(make_settings):
    app = create_app(make_settings(), transport=RouterTransport({"hermes.test": httpx.ASGITransport(app=create_mock(delay=0))}))
    with TestClient(app) as c:
        c.headers.update(HDR)
        assert c.get("/bff/h/laptop/hermes/default/messaging").status_code == 501
        assert c.get("/bff/h/laptop/hermes/default/gateway").status_code == 501


# --- Gateway -------------------------------------------------------------------------------------------
def test_gateway_status_shows_what_matters_before_you_touch_it(env):
    env.dash.state.gateway.update(running=True, state="running", busy=True, active_sessions=2)
    g = env.get(G).json()
    assert g == {"running": True, "state": "running", "busy": True, "active_sessions": 2, "version": "0.22.5"}
    assert "geheim-install-id" not in env.get(G).text


def test_start_hands_the_profile_to_hermes_and_says_started_not_running(env):
    r = env.post(f"{G}/start")
    assert r.status_code == 200 and r.json()["started"] is True and r.json()["action"] == "gateway-start"
    assert env.dash.state.gateway_calls == [("gateway-start", {"profile": "default"})]
    assert env.post("/bff/h/server/hermes/beta/gateway/start").status_code == 200 and env.dash.state.gateway_calls[-1] == ("gateway-start", {"profile": "beta"})


@pytest.mark.parametrize("what", ["stop", "restart"])
def test_interrupting_running_sessions_needs_an_explicit_confirmation(env, what):
    env.dash.state.gateway.update(running=True, state="running", busy=True, active_sessions=2)
    r = env.post(f"{G}/{what}")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "interrupt_confirmation_required" and r.json()["detail"]["active_sessions"] == 2
    assert env.dash.state.gateway_calls == []
    ok = env.post(f"{G}/{what}", json={"confirm_interrupt": True})
    assert ok.status_code == 200 and env.dash.state.gateway_calls[0][0] == f"gateway-{what}"
    if what == "stop":
        assert env.dash.state.gateway_calls[0][1]["interrupt"] is True


@pytest.mark.parametrize("what", ["stop", "restart"])
def test_an_idle_gateway_needs_no_confirmation(env, what):
    env.dash.state.gateway.update(running=True, state="running", busy=False, active_sessions=0)
    assert env.post(f"{G}/{what}").status_code == 200
    assert env.dash.state.gateway_calls[0][1].get("interrupt", False) is False


def test_a_confirmation_alone_never_interrupts_an_idle_gateway_harder(env):
    env.dash.state.gateway.update(running=True, busy=False, active_sessions=0)
    env.post(f"{G}/stop", json={"confirm_interrupt": True})
    assert env.dash.state.gateway_calls[0][1]["interrupt"] is False


def test_action_log_is_redacted_and_limited_to_gateway_actions(env):
    r = env.get(f"{G}/actions/gateway-start")
    assert r.status_code == 200 and r.json()["exit_code"] == 0 and r.json()["running"] is False
    text = r.text
    assert "gateway start ok" in text and "abc.def.ghi" not in text and "sk-secret" not in text
    assert env.get(f"{G}/actions/tools-post-setup").status_code in (404, 422)
    assert env.get(f"{G}/actions/..%2Fx").status_code in (404, 422)


# --- Telegram-Onboarding -------------------------------------------------------------------------------
T = f"{M}/telegram/onboarding"


def test_telegram_onboarding_end_to_end_without_the_token_ever_leaving_the_server(env):
    start = env.post(T, json={})
    assert start.status_code == 200 and start.json()["deep_link"].startswith("https://t.me/") and start.json()["pairing_id"] == "pair_abc123"
    pid = start.json()["pairing_id"]
    assert env.get(f"{T}/{pid}").json() == {"status": "waiting", "expires_at": "2026-10-24T18:00:00Z"}
    ready = env.get(f"{T}/{pid}").json()
    assert ready["status"] == "ready" and ready["bot_username"] == "hermes_test_bot" and ready["owner_user_id"] == "424242"
    done = env.post(f"{T}/{pid}/apply", json={"allowed_user_ids": ["424242", "7"]})
    assert done.status_code == 200 and done.json()["platform"] == "telegram" and done.json()["needs_restart"] is True
    everything = start.text + env.get(f"{T}/{pid}").text + done.text + env.get(M).text
    assert "SECRET-BOT-TOKEN" not in everything
    assert env.dash.state.profiles["default"]["env"]["TELEGRAM_ALLOWED_USERS"] == "424242,7"
    assert platforms(env)["telegram"]["configured"] is True and platforms(env)["telegram"]["enabled"] is True


def test_onboarding_applies_to_the_chosen_profile_only(env):
    pid = env.post(T, json={}).json()["pairing_id"]
    env.get(f"{T}/{pid}"); env.get(f"{T}/{pid}")
    env.post(f"{T}/{pid}/apply", json={"allowed_user_ids": ["1"]})
    assert "TELEGRAM_BOT_TOKEN" in env.dash.state.profiles["default"]["env"] and "TELEGRAM_BOT_TOKEN" not in env.dash.state.profiles["beta"]["env"]
    assert env.dash.state.gateway_calls == [("telegram-apply", {"profile": "default"})]


@pytest.mark.parametrize("link", ["http://t.me/newbot/x", "https://evil.test/t.me", "javascript:alert(1)", "https://t.me.evil.test/x", ""])
def test_only_telegram_links_are_handed_to_the_browser(env, link):
    env.dash.state.deep_link = link
    r = env.post(T, json={})
    assert r.status_code == 502 and (link not in r.text or link == "")


@pytest.mark.parametrize("ids", [[], ["abc"], ["12", "x"], ["1; rm"], ["-5"], ["1" * 40]])
def test_only_numeric_user_ids_are_accepted_and_at_least_one(env, ids):
    pid = env.post(T, json={}).json()["pairing_id"]
    env.get(f"{T}/{pid}"); env.get(f"{T}/{pid}")
    assert env.post(f"{T}/{pid}/apply", json={"allowed_user_ids": ids}).status_code == 422
    assert "TELEGRAM_BOT_TOKEN" not in env.dash.state.profiles["default"]["env"]


@pytest.mark.parametrize("pid", ["../x", "a b", "x" * 200, "%2e%2e"])
def test_pairing_ids_are_validated_before_they_reach_the_dashboard(env, pid):
    assert env.get(f"{T}/{pid}").status_code in (404, 422)
    assert env.dash.state.pairings == {}


def test_applying_before_the_bot_exists_and_unknown_sessions_are_clear_errors(env):
    pid = env.post(T, json={}).json()["pairing_id"]
    early = env.post(f"{T}/{pid}/apply", json={"allowed_user_ids": ["1"]})
    assert early.status_code == 502 and "not ready" in early.text and "TELEGRAM_BOT_TOKEN" not in env.dash.state.profiles["default"]["env"]
    assert env.get(f"{T}/pair_unbekannt").status_code == 404


def test_cancelling_forgets_the_session(env):
    pid = env.post(T, json={}).json()["pairing_id"]
    assert env.delete(f"{T}/{pid}").status_code == 200 and env.dash.state.pairings == {}


def test_bot_name_is_optional_and_limited(env):
    assert env.post(T, json={"bot_name": "Mein Hermes"}).status_code == 200
    assert env.post(T, json={"bot_name": "x" * 200}).status_code == 422
