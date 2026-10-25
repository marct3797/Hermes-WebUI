"""Kanban in der Tiefe: Diagnose, Worker, Läufe prüfen/beenden, Spezifizieren/Schätzen, Dispatch, Board wechseln.

Schranken des BFF:
- Lesen schickt nie Kommandozeilen, PIDs oder Claim-Schlüssel mit (Prozessargumente können Schlüssel enthalten),
- einen Lauf beenden unterbricht einen Agenten: frische Anmeldung, die Lauf-Nummer eintippen, danach zurücklesen,
- Spezifizieren/Schätzen verbraucht Modell-Tokens (und Spezifizieren schreibt die Aufgabe um): frisch + Rate-Limit, Spezifizieren nur mit `confirm`,
- Dispatch: Vorschau (`dry_run`) ist frei, echtes Starten nur frisch und mit `confirm_spawn`, höchstens 8,
- Board wechseln wird zurückgelesen.
Nicht durchgereicht: Anhänge, Zerlegen, Board-Import/-Export (freie Serverpfade), Orchestrierung schreiben, Profil-Metadaten schreiben.
"""
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import SESSION_COOKIE, User
from app.main import create_app
from conftest import HDR, RouterTransport
from devtools.mock_kanban import create_mock

B = "/bff/h/ct/_kanban"


@pytest.fixture
def kb(tmp_path, make_settings):
    agent = {"id": "hermes", "base_url": "http://hermes.test", "api_key": "k", "multiplex": True, "agents": ["default"]}
    f = tmp_path / "hosts.json"
    f.write_text(json.dumps({"hosts": [{"id": "ct", "runtimes": [{**agent, "dashboard": {"base_url": "http://dash.test"}}]}]}))
    mock = create_mock()
    settings = make_settings(hosts_file=f, auth_mode="oidc", oidc_issuer="https://id.test", oidc_client_id="test", oidc_client_secret="test",
                             oidc_allowed_sub="user", public_url="http://testserver", audit_file=tmp_path / "audit.jsonl")
    app = create_app(settings, transport=RouterTransport({"dash.test": httpx.ASGITransport(app=mock)}))
    with TestClient(app) as c:
        s = app.state.sessions.create(User("user", "Test"))
        s.auth_time = app.state.sessions.now()
        c.cookies.set(SESSION_COOKIE, s.id)
        c.headers.update(HDR)
        c.mock, c.audit_file = mock, tmp_path / "audit.jsonl"
        yield c


def stale(c):
    c.app.state.sessions.get(c.cookies.get(SESSION_COOKIE)).auth_time = 0


def fresh(c):
    c.app.state.sessions.get(c.cookies.get(SESSION_COOKIE)).auth_time = c.app.state.sessions.now()


def test_diagnostics_lists_tasks_with_problems_and_validates_severity(kb):
    r = kb.get(f"{B}/diagnostics")
    assert r.status_code == 200 and r.json()["count"] == 1 and r.json()["items"][0]["task_id"] == "t_aaaa0002"
    assert "actions" not in json.dumps(r.json())
    assert kb.get(f"{B}/diagnostics", params={"severity": "egal"}).status_code == 422


def test_workers_and_inspect_never_show_command_lines_pids_or_claim_locks(kb):
    w = kb.get(f"{B}/workers")
    assert w.status_code == 200 and w.json()["count"] == 1 and w.json()["workers"][0]["run_id"] == 21
    assert "4242" not in w.text and "host:4242" not in w.text
    i = kb.get(f"{B}/runs/21/inspect")
    assert i.status_code == 200 and i.json()["alive"] is True and "sk-LEAK" not in i.text and "cmdline" not in i.text and "pid" not in i.json()
    assert kb.get(f"{B}/runs/999/inspect").status_code == 404
    assert kb.get(f"{B}/runs/abc/inspect").status_code == 422


def test_terminate_needs_fresh_typed_run_number_and_reads_back(kb):
    stale(kb)
    assert kb.post(f"{B}/runs/21/terminate", json={"confirm": "21"}).status_code == 401
    fresh(kb)
    assert kb.post(f"{B}/runs/21/terminate", json={"confirm": "falsch"}).status_code == 422
    assert kb.post(f"{B}/runs/21/terminate", json={}).status_code == 422
    assert kb.get(f"{B}/workers").json()["count"] == 1
    r = kb.post(f"{B}/runs/21/terminate", json={"confirm": "21", "reason": "Test"})
    assert r.status_code == 200 and kb.get(f"{B}/workers").json()["count"] == 0
    assert kb.post(f"{B}/runs/21/terminate", json={"confirm": "21"}).status_code in (409, 502)  # schon beendet
    assert "run=21" in kb.audit_file.read_text() or "21" in kb.audit_file.read_text()


def test_terminate_that_the_dashboard_only_pretends_is_a_502(kb):
    kb.mock.state.drop_terminate = True
    assert kb.post(f"{B}/runs/21/terminate", json={"confirm": "21"}).status_code == 502


def test_specify_and_estimate_cost_tokens_so_they_need_fresh_and_specify_needs_confirm(kb):
    stale(kb)
    assert kb.post(f"{B}/tasks/t_aaaa0003/estimate").status_code == 401
    assert kb.post(f"{B}/tasks/t_aaaa0003/specify", json={"confirm": True}).status_code == 401
    fresh(kb)
    e = kb.post(f"{B}/tasks/t_aaaa0003/estimate")
    assert e.status_code == 200 and e.json()["est_tokens"] == 120000 and e.json()["complexity"] == "M"
    assert kb.post(f"{B}/tasks/t_aaaa0003/specify", json={}).status_code == 422  # schreibt die Aufgabe um
    r = kb.post(f"{B}/tasks/t_aaaa0003/specify", json={"confirm": True})
    assert r.status_code == 200 and r.json()["new_title"].endswith("(präzisiert)")
    assert kb.post(f"{B}/tasks/t_nix/estimate").status_code == 404


def test_dispatch_preview_is_free_but_real_start_needs_fresh_and_confirm(kb):
    stale(kb)
    pre = kb.post(f"{B}/dispatch", json={"dry_run": True})
    assert pre.status_code == 200 and pre.json()["dry_run"] is True and pre.json()["spawned"] == []
    assert kb.post(f"{B}/dispatch", json={"dry_run": False, "confirm_spawn": True}).status_code == 401
    fresh(kb)
    assert kb.post(f"{B}/dispatch", json={"dry_run": False}).status_code == 422
    assert kb.post(f"{B}/dispatch", json={"dry_run": False, "confirm_spawn": True, "max": 9}).status_code == 422
    r = kb.post(f"{B}/dispatch", json={"dry_run": False, "confirm_spawn": True, "max": 2})
    assert r.status_code == 200 and r.json()["spawned"] == ["t_aaaa0003"]


def test_switch_board_needs_fresh_known_slug_and_reads_back(kb):
    stale(kb)
    assert kb.post(f"{B}/boards/alpha/switch").status_code == 401
    fresh(kb)
    assert kb.post(f"{B}/boards/nix/switch").status_code == 404
    assert kb.post(f"{B}/boards/Bad Slug/switch").status_code == 422
    assert kb.post(f"{B}/boards/alpha/switch").status_code == 200
    assert kb.get(f"{B}/boards").json()["current"] == "alpha"


def test_switch_that_the_dashboard_only_pretends_is_a_502(kb):
    kb.mock.state.drop_switch = True
    assert kb.post(f"{B}/boards/alpha/switch").status_code == 502
