import json
import stat
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.adapters import UpstreamError
from app.dashboard import SOUL_MAX_CHARS, DashboardClient, SoulHistory, digest
from app.main import create_app
from app.registry import ConfigError, DashboardCfg, parse_config
from devtools.mock_dashboard import TOKEN, create_mock as create_dashboard
from devtools.mock_hermes import create_mock
from tests.conftest import BASE, HDR, RouterTransport, hosts_config

OMO = BASE.replace("/default", "/omoikane")
OLD = "Du bist ein hilfsbereiter Assistent.\n"


@pytest.fixture
def dash():
    return create_dashboard()


@pytest.fixture
def build(make_settings, dash):
    clients = []

    def make(dashboard=None, running=True, broken_lists=False, **kw):
        routes = {"hermes.test": httpx.ASGITransport(app=create_mock(delay=0, broken_lists=broken_lists))}
        if running:
            routes["dashboard.test"] = httpx.ASGITransport(app=dashboard or dash)
        transport = RouterTransport(routes)
        c = TestClient(create_app(make_settings(**kw), transport=transport))
        c.__enter__()
        c.headers.update(HDR)
        clients.append(c)
        return c
    yield make
    for c in clients:
        c.__exit__(None, None, None)


@pytest.fixture
def client(build):
    return build()


def audit_lines(tmp_path):
    return [json.loads(line) for line in (tmp_path / "audit.log").read_text().splitlines()]


# --- Konfiguration ---------------------------------------------------------------------------------------
def test_dashboard_config_token_from_env_and_hidden_in_repr():
    raw = {"hosts": [{"id": "h", "runtimes": [{"id": "hermes", "base_url": "http://x", "dashboard": {"base_url": "http://d:9122/", "token_env": "T"}}]}]}
    cfg = parse_config(raw, {"T": "geheim"})["h"].runtimes[0].dashboard
    assert cfg == DashboardCfg("http://d:9122", "geheim") and "geheim" not in repr(cfg)


@pytest.mark.parametrize("dash_cfg", [{}, {"base_url": "ftp://x"}, "http://x", {"token": "t"}])
def test_dashboard_config_rejects_unusable_entries(dash_cfg):
    raw = {"hosts": [{"id": "h", "runtimes": [{"id": "hermes", "base_url": "http://x", "dashboard": dash_cfg}]}]}
    with pytest.raises(ConfigError, match="dashboard"):
        parse_config(raw, {})


def test_shipped_configs_connect_the_container_dashboard(tmp_path):
    root = Path(__file__).resolve().parents[2]
    for name in ("deploy/hosts.json", "backend/hosts.example.json"):
        cfg = parse_config(json.loads((root / name).read_text()), {"HERMES_DASHBOARD_TOKEN": "t"})["hikari"].runtimes[0]
        assert cfg.dashboard == DashboardCfg("http://127.0.0.1:9122", "t"), name


def test_runtime_without_dashboard_has_none():
    assert parse_config(hosts_config(), {})["laptop"].runtimes[0].dashboard is None


# --- Status ----------------------------------------------------------------------------------------------
def test_status_reports_profile_data(client):
    body = client.get(f"{OMO}/dashboard").json()
    assert body["available"] is True and body["reason"] is None
    assert body["profile"] == {"name": "omoikane", "model": "claude-test", "provider": "anthropic", "description": "",
                               "description_auto": False, "skill_count": 12, "gateway_running": False, "has_env": True}


def test_status_without_dashboard_explains_instead_of_failing(client):
    body = client.get("/bff/h/laptop/hermes/default/dashboard").json()
    assert body == {"available": False, "reason": "Für diese Runtime ist kein Dashboard eingerichtet", "profile": None}


def test_status_when_dashboard_is_down(build):
    body = build(running=False).get(f"{BASE}/dashboard").json()
    assert body["available"] is False and "nicht erreichbar" in body["reason"]


def test_status_for_profile_the_dashboard_does_not_know(client):
    body = client.get(f"{BASE.replace('/default', '/ghost')}/dashboard").json()
    assert body["available"] is True and body["profile"] is None and "kennt dieses Profil nicht" in body["reason"]


def test_token_is_sent_and_a_wrong_one_is_reported(build, tmp_path):
    cfg = hosts_config()
    cfg["hosts"][0]["runtimes"][0]["dashboard"] = {"base_url": "http://dashboard.test", "token": TOKEN}
    good = tmp_path / "good.json"
    good.write_text(json.dumps(cfg))
    cfg["hosts"][0]["runtimes"][0]["dashboard"]["token"] = "falsch"
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps(cfg))
    protected = create_dashboard(token=TOKEN)
    assert build(dashboard=protected, hosts_file=good).get(f"{BASE}/dashboard").json()["available"] is True
    body = build(dashboard=protected, hosts_file=bad).get(f"{BASE}/dashboard").json()
    assert body["available"] is False and "lehnt den Zugang ab" in body["reason"] and "falsch" not in json.dumps(body)


# --- SOUL lesen ------------------------------------------------------------------------------------------
def test_read_soul(client):
    body = client.get(f"{BASE}/soul").json()
    assert body == {"content": OLD, "exists": True, "hash": digest(OLD), "max_chars": SOUL_MAX_CHARS, "history": []}


def test_read_soul_of_profile_without_file(client):
    body = client.get(f"{BASE.replace('/default', '/sora')}/soul").json()
    assert body["content"] == "" and body["exists"] is False


def test_soul_unavailable_without_dashboard(client):
    r = client.get("/bff/h/laptop/hermes/default/soul")
    assert r.status_code == 501 and "kein Dashboard" in r.json()["detail"]


def test_soul_of_unknown_profile_is_404(client, dash):
    del dash.state.profiles["omoikane"]
    assert client.get(f"{OMO}/soul").status_code == 404


# --- SOUL schreiben --------------------------------------------------------------------------------------
def test_write_soul_keeps_the_old_text_and_audits_without_content(client, dash, tmp_path):
    loaded = client.get(f"{BASE}/soul").json()
    r = client.put(f"{BASE}/soul", json={"content": "# Neu\n\nSehr geheimer Text", "base": loaded["hash"]})
    assert r.status_code == 200
    body = r.json()
    assert body["changed"] is True and body["hash"] == digest("# Neu\n\nSehr geheimer Text")
    assert dash.state.profiles["default"]["soul"] == "# Neu\n\nSehr geheimer Text"
    assert [(h["reason"], h["chars"]) for h in body["history"]] == [("vor Änderung", len(OLD))]
    vid = body["history"][0]["id"]
    assert client.get(f"{BASE}/soul/history/{vid}").json()["content"] == OLD
    entry = audit_lines(tmp_path)[-1]
    assert entry["action"] == "soul.update" and entry["detail"]["chars"] == len("# Neu\n\nSehr geheimer Text")
    assert "geheimer" not in json.dumps(entry)


def test_unchanged_text_is_a_no_op(client, tmp_path):
    r = client.put(f"{BASE}/soul", json={"content": OLD})
    assert r.json()["changed"] is False and r.json()["history"] == []


def test_write_to_profile_without_soul_has_nothing_to_back_up(client, dash):
    r = client.put(f"{BASE.replace('/default', '/sora')}/soul", json={"content": "Erste Fassung"})
    assert r.json()["changed"] is True and r.json()["history"] == []
    assert dash.state.profiles["sora"]["soul"] == "Erste Fassung"


def test_changed_in_the_meantime_gives_409_and_writes_nothing(client, dash):
    loaded = client.get(f"{BASE}/soul").json()
    dash.state.profiles["default"]["soul"] = "Der Agent hat sich selbst geändert"
    r = client.put(f"{BASE}/soul", json={"content": "Meine Fassung", "base": loaded["hash"]})
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert detail["code"] == "soul_changed" and detail["current"] == "Der Agent hat sich selbst geändert"
    assert detail["hash"] == digest("Der Agent hat sich selbst geändert")
    assert dash.state.profiles["default"]["soul"] == "Der Agent hat sich selbst geändert"
    # Mit dem neuen Fingerabdruck geht es durch, der überschriebene Text bleibt im Verlauf.
    ok = client.put(f"{BASE}/soul", json={"content": "Meine Fassung", "base": detail["hash"]})
    assert ok.status_code == 200 and ok.json()["history"][0]["chars"] == len("Der Agent hat sich selbst geändert")


def test_unconfirmed_write_is_reported(build):
    c = build(dashboard=create_dashboard(drop_writes=True))
    r = c.put(f"{BASE}/soul", json={"content": "Wird verschluckt"})
    assert r.status_code == 502 and "nicht wie gesendet" in r.json()["detail"]


def test_soul_size_limit_and_csrf(client):
    assert client.put(f"{BASE}/soul", json={"content": "x" * (SOUL_MAX_CHARS + 1)}).status_code == 422
    no_csrf = client.put(f"{BASE}/soul", json={"content": "x"}, headers={"X-Requested-With": ""})
    assert no_csrf.status_code == 403


def test_history_rejects_ids_that_are_no_versions(client):
    assert client.get(f"{BASE}/soul/history/..%2F..%2Fetc").status_code in (404, 422)
    assert client.get(f"{BASE}/soul/history/passwd").status_code == 422
    assert client.get(f"{BASE}/soul/history/20261023T170000123456").status_code == 404


# --- Wiederherstellen ------------------------------------------------------------------------------------
def test_restore_brings_back_an_old_version_and_keeps_the_current_one(client, dash, tmp_path):
    client.put(f"{BASE}/soul", json={"content": "Zweite Fassung"})
    vid = client.get(f"{BASE}/soul").json()["history"][0]["id"]
    r = client.post(f"{BASE}/soul/restore", json={"id": vid})
    assert r.status_code == 200 and r.json()["content"] == OLD
    assert dash.state.profiles["default"]["soul"] == OLD
    history = client.get(f"{BASE}/soul").json()["history"]
    assert [h["reason"] for h in history] == ["vor Wiederherstellung", "vor Änderung"]
    assert client.get(f"{BASE}/soul/history/{history[0]['id']}").json()["content"] == "Zweite Fassung"
    assert audit_lines(tmp_path)[-1]["action"] == "soul.restore"


def test_restore_of_unknown_version_is_404(client):
    assert client.post(f"{BASE}/soul/restore", json={"id": "20261023T170000123456"}).status_code == 404
    assert client.post(f"{BASE}/soul/restore", json={"id": "alles"}).status_code == 422


# --- Beschreibung und Modell -----------------------------------------------------------------------------
def test_description_is_trimmed_and_audited(client, dash, tmp_path):
    r = client.put(f"{OMO}/profile/description", json={"description": "  Bewahrt Wissen  "})
    assert r.json() == {"ok": True, "description": "Bewahrt Wissen"}
    assert dash.state.profiles["omoikane"]["description"] == "Bewahrt Wissen"
    assert audit_lines(tmp_path)[-1]["action"] == "profile.description"
    assert client.put(f"{OMO}/profile/description", json={"description": "x" * 501}).status_code == 422


def test_model_change(client, dash, tmp_path):
    r = client.put(f"{OMO}/profile/model", json={"provider": "openrouter", "model": "anthropic/claude-sonnet"})
    assert r.json() == {"ok": True, "provider": "openrouter", "model": "anthropic/claude-sonnet"}
    assert dash.state.profiles["omoikane"]["model"] == "anthropic/claude-sonnet"
    entry = audit_lines(tmp_path)[-1]
    assert entry["action"] == "profile.model" and entry["detail"]["model"] == "anthropic/claude-sonnet"


@pytest.mark.parametrize("body", [{"provider": "", "model": "m"}, {"provider": "a b", "model": "m"}, {"provider": "p", "model": "../x;rm"}, {"provider": "p"}])
def test_model_change_validates_input(client, body):
    assert client.put(f"{OMO}/profile/model", json=body).status_code == 422


def test_unknown_profile_is_404_for_writes(client, dash):
    del dash.state.profiles["omoikane"]
    assert client.put(f"{OMO}/profile/description", json={"description": "x"}).status_code == 404
    assert client.put(f"{OMO}/profile/model", json={"provider": "p", "model": "m"}).status_code == 404


# --- Bausteine -------------------------------------------------------------------------------------------
async def test_client_maps_transport_and_status_errors():
    def handler(request: httpx.Request) -> httpx.Response:
        return {"/api/profiles": httpx.Response(200, json={"profiles": "kaputt"}),
                "/api/profiles/a/soul": httpx.Response(200, json={"exists": True})}.get(request.url.path, httpx.Response(500))

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    c = DashboardClient(DashboardCfg("http://d"), http)
    with pytest.raises(UpstreamError, match="Profilliste"):
        await c.profiles()
    with pytest.raises(UpstreamError, match="unbekannter Form"):
        await c.soul("a")
    with pytest.raises(UpstreamError, match="Fehler 500"):
        await c.set_description("a", "x")


def test_history_dedupes_sorts_and_survives_damaged_files(tmp_path):
    h = SoulHistory(tmp_path / "souls")
    first = h.add("hikari", "hermes", "default", "eins", "vor Änderung")
    assert h.add("hikari", "hermes", "default", "eins", "vor Änderung") == first  # identisch zum neuesten: kein neuer Eintrag
    h.add("hikari", "hermes", "default", "zwei", "vor Änderung")
    folder = tmp_path / "souls" / "hikari__hermes__default"
    (folder / "20000101T000000000000.json").write_text("{kaputt")
    (folder / "notes.txt").write_text("fremd")
    entries = h.entries("hikari", "hermes", "default")
    assert [e["chars"] for e in entries] == [4, 4] and entries[0]["id"] > entries[1]["id"]
    assert h.get("hikari", "hermes", "default", entries[0]["id"])["content"] == "zwei"
    assert h.get("hikari", "hermes", "default", "20000101T000000000000") is None
    assert h.get("hikari", "hermes", "default", "../x") is None
    assert h.entries("hikari", "hermes", "anderer") == []  # je Agent getrennt
    assert stat.S_IMODE(folder.stat().st_mode) == 0o700 and stat.S_IMODE((folder / f"{first}.json").stat().st_mode) == 0o600


# --- Skills und Werkzeuge: Ersatzquelle, wenn die Agent-API die Liste nicht liefern kann ------------------
def test_skills_come_from_the_agent_api_when_it_works(client):
    body = client.get(f"{BASE}/skills").json()
    assert body.get("source") is None and "github-pr-review" in {s["name"] for s in body["data"]}


def test_skills_fall_back_to_the_dashboard_when_hermes_cannot_list_them(build):
    body = build(broken_lists=True).get(f"{BASE}/skills").json()
    assert body["source"] == "dashboard" and [s["name"] for s in body["data"]] == ["plan", "mein-skill"]
    assert "Failed to enumerate skills" in body["note"] and "Dashboard" in body["note"]


def test_toolsets_fall_back_the_same_way(build):
    body = build(broken_lists=True).get(f"{BASE}/toolsets").json()
    assert body["source"] == "dashboard" and {t["name"]: t["enabled"] for t in body["data"]} == {"terminal": True, "web": False}


def test_without_a_dashboard_the_original_error_stays_visible(build):
    r = build(broken_lists=True, running=False).get(f"{BASE}/skills")
    assert r.status_code == 500 and "Failed to enumerate skills" in r.json()["detail"]


def test_a_dashboard_that_cannot_help_does_not_hide_the_original_error(build):
    r = build(broken_lists=True, dashboard=create_dashboard(token="anderer")).get(f"{BASE}/skills")
    assert r.status_code == 500 and "Failed to enumerate skills" in r.json()["detail"]
