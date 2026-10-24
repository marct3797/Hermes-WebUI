"""Einrichtungsassistent deploy/setup.py: gegen echte lokale Testserver, ohne Netz nach außen."""
import importlib.util
import json
import stat
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

DEPLOY = Path(__file__).resolve().parents[2] / "deploy"
spec = importlib.util.spec_from_file_location("hermes_setup", DEPLOY / "setup.py")
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)

IDP = "https://id.example.test"  # https wie in prod; die Anfrage wird auf den lokalen Testserver umgelenkt
GATEWAY_KEY, DASH_TOKEN = "gw-key-0123456789", "dash-token-abcdef"
CLIENT_SECRET = "oidc-secret-xyz"


class Fake(BaseHTTPRequestHandler):
    claims = ["sub", "auth_time"]
    issuer = IDP
    seen: list = []

    def log_message(self, *a):
        pass

    def do_GET(self):
        Fake.seen.append((self.path, self.headers.get("Authorization"), self.headers.get("X-Hermes-Session-Token")))
        ok = {"/v1/capabilities": self.headers.get("Authorization") == f"Bearer {GATEWAY_KEY}",
              "/api/profiles": self.headers.get("X-Hermes-Session-Token") in (DASH_TOKEN, None) and self.path == "/api/profiles"}
        if self.path == "/.well-known/openid-configuration":
            body, code = {"issuer": Fake.issuer, "claims_supported": Fake.claims}, 200
        elif ok.get(self.path):
            body, code = {"ok": True}, 200
        else:
            body, code = {"detail": "nein"}, 401
        data = json.dumps(body).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(data))); self.end_headers()
        self.wfile.write(data)


@pytest.fixture
def server(monkeypatch):
    Fake.seen, Fake.claims, Fake.issuer = [], ["sub", "auth_time"], IDP
    s = HTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    base, real = f"http://127.0.0.1:{s.server_port}", setup.fetch
    monkeypatch.setattr(setup, "fetch", lambda url, *a, **k: real(url.replace(IDP, base), *a, **k))
    yield base
    s.shutdown()


def drive(target, answers, secrets, argv_extra=()):
    """Antworten der Reihe nach; eine nicht erwartete Frage lässt den Test scheitern."""
    asked, shown = [], []
    a, s = iter(answers), iter(secrets)

    def ask(prompt):
        asked.append(prompt)
        return next(a)

    code = setup.main([str(target), *argv_extra], ask=ask, secret=lambda p: next(s), out=shown.append)
    return code, asked, "\n".join(shown)


def fresh_answers(base, private="n", stepup="j", hide=""):
    # Gateway-URL, Profil, Dashboard ja, Dashboard-URL, öffentliche URL, Anbieter, Client-ID, erlaubte Kennung, privat?, [Step-up aus?], ausblenden
    return [base, "default", "j", base, "https://webui.example.test", IDP, "client-1", "user-1", private, *([stepup] if private == "j" else []), hide]


def test_fresh_setup_writes_minimal_config_with_private_modes_and_never_prints_secrets(tmp_path, server):
    target = tmp_path / "wui"
    code, asked, out = drive(target, fresh_answers(server), [GATEWAY_KEY, DASH_TOKEN, CLIENT_SECRET])
    assert code == 0, out
    hosts = json.loads((target / "config" / "hosts.json").read_text())["hosts"]
    rt = hosts[0]["runtimes"][0]
    assert rt["base_url"] == server and rt["agents"] == ["default"] and rt["multiplex"] is False
    assert rt["dashboard"] == {"base_url": server, "token_env": "HERMES_DASHBOARD_TOKEN"}
    env = setup.read_env(target / "webui.env")
    assert env["HERMES_KEY_LOCAL"] == GATEWAY_KEY and env["HERMES_DASHBOARD_TOKEN"] == DASH_TOKEN
    assert env["HERMES_WEBUI_OIDC_CLIENT_SECRET"] == CLIENT_SECRET and env["HERMES_WEBUI_PUBLIC_URL"] == "https://webui.example.test"
    assert env["HERMES_WEBUI_OIDC_ALLOWED_SUB"] == "user-1" and env["HERMES_WEBUI_AUTH_MODE"] == "oidc"
    assert "HERMES_WEBUI_STEP_UP" not in env or env["HERMES_WEBUI_STEP_UP"] != "off"
    for f in (target / "webui.env", target / "config" / "hosts.json"):
        assert stat.S_IMODE(f.stat().st_mode) & 0o077 == 0, f
    for secret in (GATEWAY_KEY, DASH_TOKEN, CLIENT_SECRET):
        assert secret not in out and not any(secret in q for q in asked)
    assert "https://webui.example.test/auth/callback" in out  # die Redirect-URI für die OAuth-App


def test_connection_tests_use_the_typed_keys_and_report_each_result(tmp_path, server):
    code, _, out = drive(tmp_path / "w", fresh_answers(server), [GATEWAY_KEY, DASH_TOKEN, CLIENT_SECRET])
    paths = {p for p, *_ in Fake.seen}
    assert {"/v1/capabilities", "/api/profiles", "/.well-known/openid-configuration"} <= paths
    assert ("/v1/capabilities", f"Bearer {GATEWAY_KEY}", None) in Fake.seen
    assert out.count("OK") >= 3 and "FEHLER" not in out


def test_wrong_gateway_key_is_reported_and_nothing_is_written_unless_confirmed(tmp_path, server):
    target = tmp_path / "w"
    code, _, out = drive(target, fresh_answers(server) + ["n"], ["falscher-key", DASH_TOKEN, CLIENT_SECRET])
    assert "FEHLER" in out and "Gateway" in out
    assert code == 1 and not (target / "config" / "hosts.json").exists() and not (target / "webui.env").exists()


def test_private_network_answer_suggests_turning_step_up_off(tmp_path, server):
    target = tmp_path / "w"
    drive(target, fresh_answers(server, private="j"), [GATEWAY_KEY, DASH_TOKEN, CLIENT_SECRET])
    assert setup.read_env(target / "webui.env")["HERMES_WEBUI_STEP_UP"] == "off"


def test_private_network_but_step_up_kept_is_respected(tmp_path, server):
    drive(tmp_path / "w", fresh_answers(server, private="j", stepup="n"), [GATEWAY_KEY, DASH_TOKEN, CLIENT_SECRET])
    assert setup.read_env(tmp_path / "w" / "webui.env").get("HERMES_WEBUI_STEP_UP") != "off"


def test_public_network_keeps_step_up_on_and_does_not_even_ask(tmp_path, server):
    code, asked, _ = drive(tmp_path / "w", fresh_answers(server, private="n"), [GATEWAY_KEY, DASH_TOKEN, CLIENT_SECRET])
    assert not any("abschalten" in q for q in asked)


def test_step_up_proof_of_the_provider_is_explained(tmp_path, server):
    _, _, out = drive(tmp_path / "a", fresh_answers(server), [GATEWAY_KEY, DASH_TOKEN, CLIENT_SECRET])
    assert "auth_time" in out and "belegt" in out
    Fake.claims = ["sub"]
    _, _, out = drive(tmp_path / "b", fresh_answers(server), [GATEWAY_KEY, DASH_TOKEN, CLIENT_SECRET])
    assert "prompt=login" in out and "nicht belegt" in out


def test_hidden_providers_are_written(tmp_path, server):
    drive(tmp_path / "w", fresh_answers(server, hide=" Nous , opencode-zen "), [GATEWAY_KEY, DASH_TOKEN, CLIENT_SECRET])
    assert setup.read_env(tmp_path / "w" / "webui.env")["HERMES_WEBUI_HIDDEN_PROVIDERS"] == "nous,opencode-zen"


@pytest.mark.parametrize("url", ["http://webui.example.test", "webui.example.test", "https://"])
def test_public_url_must_be_https(tmp_path, server, url):
    answers = fresh_answers(server)
    answers[4:5] = [url, "https://webui.example.test"]
    code, _, out = drive(tmp_path / "w", answers, [GATEWAY_KEY, DASH_TOKEN, CLIENT_SECRET])
    assert "https" in out and setup.read_env(tmp_path / "w" / "webui.env")["HERMES_WEBUI_PUBLIC_URL"] == "https://webui.example.test"


def test_profile_name_is_validated(tmp_path, server):
    answers = fresh_answers(server)
    answers[1:2] = ["../etc", "mein-profil"]
    drive(tmp_path / "w", answers, [GATEWAY_KEY, DASH_TOKEN, CLIENT_SECRET])
    assert json.loads((tmp_path / "w/config/hosts.json").read_text())["hosts"][0]["runtimes"][0]["agents"] == ["mein-profil"]


def test_existing_setup_is_kept_and_only_missing_parts_are_asked(tmp_path, server):
    target = tmp_path / "w"
    drive(target, fresh_answers(server), [GATEWAY_KEY, DASH_TOKEN, CLIENT_SECRET])
    hosts_before = (target / "config" / "hosts.json").read_text()
    env = setup.read_env(target / "webui.env")
    (target / "webui.env").write_text((target / "webui.env").read_text() + "# eigene Zeile\nMEINE_VARIABLE=bleibt\n")
    code, asked, out = drive(target, ["n", "n", "nous"], [])  # Anmeldung ändern? nein; privat? nein; ausblenden: nous
    assert code == 0, out
    assert setup.read_env(target / "webui.env")["HERMES_WEBUI_HIDDEN_PROVIDERS"] == "nous"
    assert (target / "config" / "hosts.json").read_text() == hosts_before
    assert "MEINE_VARIABLE=bleibt" in (target / "webui.env").read_text() and "# eigene Zeile" in (target / "webui.env").read_text()
    assert setup.read_env(target / "webui.env")["HERMES_KEY_LOCAL"] == env["HERMES_KEY_LOCAL"]
    assert not any("Gateway-URL" in q for q in asked)
    assert (target / "webui.env.bak").exists(), "Sicherung der alten webui.env fehlt"
    assert stat.S_IMODE((target / "webui.env.bak").stat().st_mode) & 0o077 == 0


def test_unreachable_servers_do_not_crash_the_wizard(tmp_path):
    answers = fresh_answers("http://127.0.0.1:9")
    code, _, out = drive(tmp_path / "w", answers + ["j"], [GATEWAY_KEY, DASH_TOKEN, CLIENT_SECRET])
    assert "FEHLER" in out and code == 0


def test_issuer_must_be_https_like_the_server_demands(tmp_path, server):
    answers = fresh_answers(server)
    answers[5:6] = ["http://id.example.test", IDP]
    drive(tmp_path / "w", answers, [GATEWAY_KEY, DASH_TOKEN, CLIENT_SECRET])
    assert setup.read_env(tmp_path / "w" / "webui.env")["HERMES_WEBUI_OIDC_ISSUER"] == IDP


def test_issuer_that_differs_from_the_discovery_is_an_error(tmp_path, server):
    Fake.issuer = "https://anderer-anbieter.test"
    code, _, out = drive(tmp_path / "w", fresh_answers(server) + ["n"], [GATEWAY_KEY, DASH_TOKEN, CLIENT_SECRET])
    assert code == 1 and "meldet den Issuer" in out


def test_settings_written_by_the_wizard_are_accepted_by_the_server(tmp_path, server, monkeypatch):
    """Was der Assistent schreibt, muss die Startprüfung des Servers bestehen (prod verlangt https, Kennung, Secret)."""
    from app.auth import assert_auth_configured
    from app.config import Settings
    drive(tmp_path / "w", fresh_answers(server), [GATEWAY_KEY, DASH_TOKEN, CLIENT_SECRET])
    for k, v in setup.read_env(tmp_path / "w" / "webui.env").items():
        monkeypatch.setenv(k, v)
    assert_auth_configured(Settings())


def test_dashboard_url_with_a_foreign_host_name_is_warned_about(tmp_path, server):
    answers = fresh_answers(server)
    answers[3] = "http://dashboard.example.test:9119"
    code, _, out = drive(tmp_path / "w", answers + ["j"], [GATEWAY_KEY, DASH_TOKEN, CLIENT_SECRET])
    assert "Tunnel" in out and "127.0.0.1" in out


def test_loopback_dashboard_url_gets_no_warning(tmp_path, server):
    code, _, out = drive(tmp_path / "w", fresh_answers(server), [GATEWAY_KEY, DASH_TOKEN, CLIENT_SECRET])
    assert "Tunnel" not in out
