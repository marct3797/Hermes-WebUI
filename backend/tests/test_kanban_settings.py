"""Etappe 2: Kanban-Einstellungen (Orchestrierung, Profil-Beschreibungen, Heimatkanäle, Spalten, Modelle, Projekte)."""
import json

from tests.test_kanban_admin import B, fresh, kb, stale  # noqa: F401  (Fixture und Helfer)


def test_settings_bundle_has_all_parts_and_no_paths(kb):
    r = kb.get(f"{B}/settings")
    assert r.status_code == 200
    b = r.json()
    assert b["orchestration"]["auto_decompose"] is True and b["config"]["render_markdown"] is True
    assert [c["key"] for c in b["columns"]] == ["todo", "ready", "done"]
    assert {p["name"] for p in b["profiles"]} == {"default", "beta"} and b["notes"] == {}


def test_settings_survive_an_old_hermes_without_the_routes(kb):
    kb.mock.state.fail = 404
    b = kb.get(f"{B}/settings").json()
    assert b["orchestration"] is None and b["profiles"] is None and b["config"] is None and set(b["notes"]) == {"config", "orchestration", "workflow", "profiles"}


def test_orchestration_write_needs_fresh_login_and_reads_back(kb):
    stale(kb)
    assert kb.put(f"{B}/orchestration", json={"auto_decompose": False}).status_code == 401
    fresh(kb)
    r = kb.put(f"{B}/orchestration", json={"auto_decompose": False, "orchestrator_profile": "beta"})
    assert r.status_code == 200 and r.json()["auto_decompose"] is False and r.json()["orchestrator_profile"] == "beta"
    assert "kanban.orchestration" in kb.audit_file.read_text()


def test_orchestration_rejects_unknown_profile_extra_fields_and_empty_bodies(kb):
    assert kb.put(f"{B}/orchestration", json={}).status_code == 422
    assert kb.put(f"{B}/orchestration", json={"x": 1}).status_code == 422
    assert kb.put(f"{B}/orchestration", json={"orchestrator_profile": "../etc"}).status_code == 422
    assert kb.put(f"{B}/orchestration", json={"orchestrator_profile": "gibtsnicht"}).status_code in (400, 502)


def test_orchestration_detects_a_write_that_did_not_stick(kb):
    kb.mock.state.drop_orch = True
    assert kb.put(f"{B}/orchestration", json={"auto_decompose": False}).status_code == 502


def test_description_sets_and_clears_without_logging_the_text(kb):
    r = kb.patch(f"{B}/profiles/beta", json={"description": "Schreibt Tests"})
    assert r.status_code == 200 and r.json()["description"] == "Schreibt Tests"
    assert "Schreibt Tests" not in kb.audit_file.read_text() and "kanban.profile_description" in kb.audit_file.read_text()
    assert kb.patch(f"{B}/profiles/beta", json={"description": ""}).json()["description"] == ""
    assert kb.patch(f"{B}/profiles/beta", json={"description": "x" * 301}).status_code == 422
    assert kb.patch(f"{B}/profiles/Beta", json={"description": "x"}).status_code == 422
    assert kb.patch(f"{B}/profiles/gibtsnicht", json={"description": "x"}).status_code == 404


def test_auto_description_needs_confirm_and_reports_refusal_as_data(kb):
    assert kb.post(f"{B}/profiles/beta/describe-auto", json={}).status_code == 422
    assert not any("describe-auto" in c[1] for c in kb.mock.state.calls)
    ok = kb.post(f"{B}/profiles/beta/describe-auto", json={"confirm": True}).json()
    assert ok["ok"] is True and ok["description"] == "Automatisch beschrieben"
    no = kb.post(f"{B}/profiles/default/describe-auto", json={"confirm": True}).json()  # hat schon eine Beschreibung
    assert no["ok"] is False and no["reason"]


def test_home_channels_show_platform_and_state_but_never_chat_ids(kb):
    r = kb.get(f"{B}/home-channels", params={"task_id": "t_aaaa0001"})
    assert r.json() == {"home_channels": [{"platform": "telegram", "name": "Marc privat", "subscribed": False}]}
    assert "12345" not in r.text
    assert kb.post(f"{B}/tasks/t_aaaa0001/home-subscribe/telegram").json() == {"ok": True, "task_id": "t_aaaa0001", "platform": "telegram"}
    assert kb.get(f"{B}/home-channels", params={"task_id": "t_aaaa0001"}).json()["home_channels"][0]["subscribed"] is True
    assert kb.delete(f"{B}/tasks/t_aaaa0001/home-subscribe/telegram").status_code == 200
    assert kb.get(f"{B}/home-channels", params={"task_id": "t_aaaa0001"}).json()["home_channels"][0]["subscribed"] is False
    assert kb.post(f"{B}/tasks/t_aaaa0001/home-subscribe/discord").status_code == 404
    assert kb.post(f"{B}/tasks/t_aaaa0001/home-subscribe/Tele..gram").status_code == 422
    stale(kb)
    assert kb.post(f"{B}/tasks/t_aaaa0001/home-subscribe/telegram").status_code == 401


def test_model_options_and_projects_are_pathless(kb):
    assert kb.get(f"{B}/model-options").json()["providers"][0]["models"] == ["claude-test", "claude-test-2"]
    p = kb.get(f"{B}/projects")
    assert p.json()["projects"][0]["slug"] == "web" and "/home/geheim" not in p.text and "primary_path" not in p.text
