"""Chat-Eingabe: model_options im Run, Befehlsliste, @-Bezüge, Skill-Anweisung."""
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app import composer
from app.auth import SESSION_COOKIE, User
from app.main import create_app
from conftest import BASE, HDR, RouterTransport
from devtools.mock_composer import create_mock as create_composer
from devtools.mock_hermes import create_mock as create_hermes
from test_operations import TOKEN


class Recording(httpx.AsyncBaseTransport):
    """Merkt sich die Bodies von POST /v1/runs und reicht an den Hermes-Mock weiter."""

    def __init__(self, inner):
        self.inner, self.bodies = inner, []

    async def handle_async_request(self, request):
        if request.method == "POST" and request.url.path.endswith("/v1/runs"):
            self.bodies.append(json.loads(request.content))
        return await self.inner.handle_async_request(request)


@pytest.fixture
def env(tmp_path, make_settings, monkeypatch):
    monkeypatch.setenv("TEST_HOSTD", TOKEN)
    hostd = {"base_url": "http://daemon.test", "token_env": "TEST_HOSTD"}
    agent = {"id": "hermes", "base_url": "http://hermes.test", "api_key": "dev-key", "multiplex": True, "agents": ["default"]}
    f = tmp_path / "hosts.json"
    f.write_text(json.dumps({"hosts": [
        {"id": "ct", "hostd": hostd, "runtimes": [{**agent, "dashboard": {"base_url": "http://dash.test"}}]},
        {"id": "nodaemon", "runtimes": [agent]},
    ]}))
    mock = create_composer()
    rec = Recording(httpx.ASGITransport(app=create_hermes(wait_for_user=False, delay=0)))
    transport = RouterTransport({"hermes.test": rec, "daemon.test": httpx.ASGITransport(app=mock), "dash.test": httpx.ASGITransport(app=mock)})
    app = create_app(make_settings(hosts_file=f), transport=transport)
    with TestClient(app) as c:
        c.headers.update(HDR)
        yield c, rec, mock


def expand(c, text, workspace="alpha", host="ct"):
    return c.post(f"/bff/h/{host}/_composer/expand", json={"workspace": workspace, "text": text})


# --- model_options -------------------------------------------------------------------------
def test_reasoning_is_forwarded_to_run_body(env):
    c, rec, _ = env
    r = c.post(f"/bff/h/ct/hermes/default/runs", json={"text": "hallo", "model_options": {"reasoning": {"enabled": True, "effort": "xhigh"}}})
    assert r.status_code == 202, r.text
    assert rec.bodies[-1]["model_options"] == {"reasoning": {"enabled": True, "effort": "xhigh"}}


def test_without_choice_nothing_new_is_sent(env):
    c, rec, _ = env
    assert c.post("/bff/h/ct/hermes/default/runs", json={"text": "hallo"}).status_code == 202
    assert "model_options" not in rec.bodies[-1]


def test_reasoning_off_is_forwarded(env):
    c, rec, _ = env
    c.post("/bff/h/ct/hermes/default/runs", json={"text": "hallo", "model_options": {"reasoning": {"enabled": False}}})
    assert rec.bodies[-1]["model_options"] == {"reasoning": {"enabled": False}}


@pytest.mark.parametrize("options", [
    {"reasoning": {"effort": "wahnsinn"}}, {"reasoning": {"effort": "high", "extra": 1}},
    {"fast": True}, {"service_tier": "priority"}, {"reasoning": {"enabled": "vielleicht"}}, "high",
])
def test_unknown_model_options_are_rejected(env, options):
    c, rec, _ = env
    assert c.post("/bff/h/ct/hermes/default/runs", json={"text": "hallo", "model_options": options}).status_code == 422
    assert rec.bodies == []


# --- Befehle -------------------------------------------------------------------------------
def test_commands_are_honestly_marked(env):
    c, _, _ = env
    data = c.get("/bff/h/ct/hermes/default/_commands").json()
    by = {x["name"]: x for x in data["commands"]}
    assert len(by) > 80
    assert {n for n, x in by.items() if x["status"] == "webui"} == {"new", "stop", "reasoning", "model"}
    assert by["new"]["aliases"] == ["reset"] and by["reasoning"]["args_hint"]
    assert by["history"]["status"] == "terminal" and by["approve"]["status"] == "messaging"
    assert all(x["note"] for x in by.values())
    assert c.get("/bff/h/ct/hermes/unbekannt/_commands").status_code == 404


# --- @-Bezüge ------------------------------------------------------------------------------
def test_parse_matches_hermes_syntax():
    refs = composer.parse_refs('siehe @file:src/app.py:2-3, (@folder:src) @diff und @staged @git:3 @url:https://example.com/x. a@file:no @file:`mit leer.txt`')
    assert [(r["kind"], r["target"]) for r in refs] == [("file", "src/app.py"), ("folder", "src"), ("diff", ""), ("staged", ""), ("git", "3"), ("url", "https://example.com/x"), ("file", "mit leer.txt")]
    assert (refs[0]["start"], refs[0]["end"]) == (2, 3)


def test_file_folder_and_range(env):
    c, _, _ = env
    r = expand(c, "lies @file:README.md:2-2 und @folder:src und @folder:.").json()
    assert [x["ok"] for x in r["refs"]] == [True, True, True]
    assert "--- Attached Context ---" in r["text"] and r["text"].startswith("lies @file:README.md:2-2")
    assert "```markdown\nZweite Zeile\n\n```" in r["text"] and "app.py (" in r["text"] and "src/" in r["text"]
    assert r["tokens"] > 0 and r["blocked"] is False


def test_git_references(env):
    c, _, mock = env
    r = expand(c, "@diff @staged @git:3").json()
    assert all(x["ok"] for x in r["refs"])
    assert "+offene-zeile" in r["text"] and "+staged-zeile" in r["text"] and "n=3" in r["text"]
    assert "git diff --staged" in r["text"] and "git log -3" in r["text"]
    assert ("git", "alpha", "log", 3) in mock.state.calls


@pytest.mark.parametrize("text,reason", [
    ("@file:fehlt.txt", "nicht gefunden"), ("@file:.env", "verweigert"), ("@file:secret.txt", "verweigert"),
    ("@file:bin.dat", "binäre Datei"), ("@file:huge.txt", "zu groß"), ("@file:../etc/passwd", "relativ"),
    ("@file:/etc/passwd", "relativ"), ("@folder:~", "relativ"), ("@git:abc", "Zahl"),
])
def test_per_reference_errors(env, text, reason):
    c, _, mock = env
    r = expand(c, text).json()
    assert r["refs"][0]["ok"] is False and reason in r["refs"][0]["error"]
    assert "--- Context Warnings ---" in r["text"] and "--- Attached Context ---" not in r["text"]
    assert not any(call[0] == "files" and ".." in call[2] for call in mock.state.calls)


def test_missing_workspace_and_missing_hostd(env):
    c, _, _ = env
    r = c.post("/bff/h/ct/_composer/expand", json={"text": "@file:README.md @diff"}).json()
    assert [x["error"] for x in r["refs"]] == ["kein Arbeitsordner gewählt"] * 2
    plain = c.post("/bff/h/ct/_composer/expand", json={"text": "kein Bezug"}).json()
    assert plain["text"] == "kein Bezug" and plain["refs"] == []
    gone = c.post("/bff/h/nodaemon/_composer/expand", json={"workspace": "alpha", "text": "@file:README.md"}).json()
    assert gone["refs"][0]["error"] == "kein Host-Dienst erreichbar"


def test_unknown_workspace_and_input_validation(env):
    c, _, _ = env
    assert "nicht gefunden" in expand(c, "@file:README.md", workspace="beta").json()["refs"][0]["error"]
    assert expand(c, "x", workspace="../x").status_code == 422
    assert c.post("/bff/h/ct/_composer/expand", json={"text": "x", "extra": 1}).status_code == 422
    assert c.post("/bff/h/ct/_composer/expand", json={"text": ""}).status_code == 422


def test_url_stays_text_and_is_never_fetched(env):
    c, _, mock = env
    r = expand(c, "lies @url:https://example.com/seite bitte").json()
    assert r["text"] == "lies @url:https://example.com/seite bitte"
    assert r["refs"] == [{"raw": "@url:https://example.com/seite", "kind": "url", "ok": True, "tokens": 0, "passthrough": True, "error": None}]
    assert not any(call[0] in ("files", "git") for call in mock.state.calls)


def test_secrets_are_redacted_and_limits(env):
    c, _, _ = env
    r = expand(c, "@file:src/app.py").json()
    assert "redacted:" not in r["text"] and "print('hallo')" in r["text"]
    many = expand(c, " ".join(f"@file:README.md:{i}" for i in range(1, 19))).json()
    assert len(many["refs"]) == 18 and sum(1 for x in many["refs"] if x["ok"]) == 16
    assert "höchstens 16" in many["refs"][-1]["error"]


def test_too_much_context_is_blocked(monkeypatch, env):
    c, _, _ = env
    monkeypatch.setattr(composer, "MAX_TOKENS", 5)
    r = expand(c, "@file:README.md").json()
    assert r["blocked"] is True and r["text"] == "@file:README.md" and "abgelehnt" in r["warnings"][-1]


def test_old_hostd_and_no_repository(tmp_path, make_settings, monkeypatch):
    monkeypatch.setenv("TEST_HOSTD", TOKEN)
    f = tmp_path / "h.json"
    f.write_text(json.dumps({"hosts": [{"id": "ct", "hostd": {"base_url": "http://daemon.test", "token_env": "TEST_HOSTD"}, "runtimes": []}]}))
    for kw, reason in [({"old_hostd": True}, "zu alt"), ({"repository": False}, "Kein Git-Repository")]:
        app = create_app(make_settings(hosts_file=f), transport=RouterTransport({"daemon.test": httpx.ASGITransport(app=create_composer(**kw))}))
        with TestClient(app) as c:
            c.headers.update(HDR)
            assert reason in expand(c, "@staged").json()["refs"][0]["error"]


def test_expand_audit_has_no_content(env, tmp_path):
    c, _, _ = env
    expand(c, "@file:README.md Geheimtext-12345")
    log = (tmp_path / "audit.log").read_text()
    assert "composer.expand" in log and "Geheimtext" not in log and "Zweite Zeile" not in log


# --- Skill-Anweisung -----------------------------------------------------------------------
def test_skill_message_has_hermes_format(env):
    c, _, _ = env
    r = c.post("/bff/h/ct/hermes/default/_skill", json={"name": "plan", "instruction": "Ziel: Release"})
    assert r.status_code == 200, r.text
    text = r.json()["text"]
    assert text.startswith('[IMPORTANT: The user has invoked the "plan" skill, indicating they want you to follow its instructions.')
    assert "# Plan\nZerlege die Aufgabe." in text
    assert text.endswith("The user has provided the following instruction alongside the skill invocation: Ziel: Release")
    assert c.post("/bff/h/ct/hermes/default/_skill", json={"name": "plan"}).json()["text"].endswith("Zerlege die Aufgabe.")


@pytest.mark.parametrize("body,status", [({"name": "gibt-es-nicht"}, 404), ({"name": "../x"}, 422), ({"name": "a/b"}, 422), ({"name": "plan", "x": 1}, 422)])
def test_skill_errors(env, body, status):
    c, _, _ = env
    assert c.post("/bff/h/ct/hermes/default/_skill", json=body).status_code == status
