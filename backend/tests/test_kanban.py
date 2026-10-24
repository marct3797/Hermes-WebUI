"""Kanban-Routen gegen das Mock-Plugin (devtools/mock_kanban.py): Lesen, Schreiben, Fehler, Schwärzung, kein Löschen."""
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
    f.write_text(json.dumps({"hosts": [{"id": "ct", "runtimes": [{**agent, "dashboard": {"base_url": "http://dash.test"}}]}, {"id": "plain", "runtimes": [agent]}]}))
    mock = create_mock()
    settings = make_settings(hosts_file=f, auth_mode="oidc", oidc_issuer="https://id.test", oidc_client_id="test", oidc_client_secret="test",
                             oidc_allowed_sub="user", public_url="http://testserver", audit_file=tmp_path / "audit.jsonl")
    app = create_app(settings, transport=RouterTransport({"dash.test": httpx.ASGITransport(app=mock)}))
    with TestClient(app) as client:
        session = app.state.sessions.create(User("user", "Test"))
        session.auth_time = app.state.sessions.now()
        client.cookies.set(SESSION_COOKIE, session.id)
        client.headers.update(HDR)
        yield client, mock, app, tmp_path / "audit.jsonl"


def test_boards_list_is_slim(kb):
    c, *_ = kb
    r = c.get(f"{B}/boards").json()
    assert [b["slug"] for b in r["boards"]] == ["default", "alpha"] and r["current"] == "default"
    d = r["boards"][0]
    assert d["counts"] == {"done": 1, "blocked": 1, "ready": 1, "todo": 1, "archived": 1} and d["total"] == 4 and "db_path" not in d and "default_workdir" not in d


def test_board_columns_cards_assignees_and_no_paths(kb):
    c, *_ = kb
    r = c.get(f"{B}/board", params={"board": "default"}).json()
    assert [x["name"] for x in r["columns"]] == ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done"]
    cards = {t["id"]: t for col in r["columns"] for t in col["tasks"]}
    assert "t_aaaa0005" not in cards  # archiviert
    blocked = cards["t_aaaa0002"]
    assert blocked["warnings"] == {"count": 1, "highest_severity": "warning"} and blocked["comment_count"] == 1 and blocked["age_seconds"] == 3600
    assert "geheim123" not in cards["t_aaaa0003"]["snippet"] and "Bericht" in cards["t_aaaa0003"]["snippet"]
    assert cards["t_aaaa0004"]["link_counts"] == {"parents": 1, "children": 0}
    assert {a["name"] for a in r["assignees"]} >= {"alpha", "beta", "gamma"}
    assert r["stats"]["by_status"]["done"] == 1 and r["stats"]["oldest_ready_age_seconds"] == 120
    assert "workspace_path" not in json.dumps(r)
    assert any(x["name"] == "archived" for x in c.get(f"{B}/board", params={"include_archived": "true"}).json()["columns"])


def test_unknown_board_task_and_host(kb):
    c, *_ = kb
    assert c.get(f"{B}/board", params={"board": "nix"}).status_code == 404
    assert c.get(f"{B}/tasks/t_nix").status_code == 404
    assert c.get("/bff/h/nope/_kanban/boards").status_code == 404
    assert c.get("/bff/h/plain/_kanban/boards").status_code == 503
    assert c.get(f"{B}/board", params={"board": "../x"}).status_code == 422
    assert c.get(f"{B}/tasks/a..b%2Fc").status_code in (404, 422)


def test_task_detail_shape_and_redaction(kb):
    c, *_ = kb
    r = c.get(f"{B}/tasks/t_aaaa0002").json()
    assert r["task"]["status"] == "blocked" and r["comments"][0]["body"] == "Wartet auf Antwort"
    assert r["runs"][0]["summary"] == "Blockiert\n[redacted]" and "claim_lock" not in r["runs"][0]
    assert r["diagnostics"][0]["kind"] == "stuck_in_blocked" and r["events"][0] == {"id": 1, "kind": "created", "created_at": 1_791_996_400, "run_id": None}
    assert "workspace_path" not in json.dumps(r)
    # Text der Person wird für das Bearbeiten nie geschwärzt
    assert "geheim123" in c.get(f"{B}/tasks/t_aaaa0003").json()["task"]["body"]
    assert c.get(f"{B}/tasks/t_aaaa0004").json()["links"] == {"parents": ["t_aaaa0003"], "children": []}


def test_log_is_redacted_and_pathless(kb):
    c, *_ = kb
    r = c.get(f"{B}/tasks/t_aaaa0002/log", params={"tail": 100}).json()
    assert "abc123" not in r["content"] and "pw" not in r["content"] and "token=1" not in r["content"]
    assert "[redacted]" in r["content"] and "https://example.com/pfad" in r["content"] and r["exists"] and "path" not in r
    assert c.get(f"{B}/tasks/t_aaaa0002/log", params={"tail": 0}).status_code == 422


def test_todo_is_created_as_triage_first_so_nothing_dispatches_in_between(kb):
    c, mock, _, _ = kb
    tid = c.post(f"{B}/tasks", json={"title": "Später", "status": "todo"}).json()["id"]
    sent = [x for x in mock.state.calls if x[0] in ("POST", "PATCH") and x[1].endswith(("/tasks", f"/tasks/{tid}"))][-2:]
    assert json.loads(sent[0][3])["triage"] is True and sent[1][:2] == ("PATCH", f"/api/plugins/kanban/tasks/{tid}") and json.loads(sent[1][3]) == {"status": "todo"}
    ready = c.post(f"{B}/tasks", json={"title": "Los", "assignee": "beta"}).json()["id"]
    assert [x for x in mock.state.calls if x[0] == "POST" and x[1].endswith("/tasks")][-1][3] and json.loads([x for x in mock.state.calls if x[0] == "POST" and x[1].endswith("/tasks")][-1][3])["triage"] is False  # ready bleibt ready
    assert c.get(f"{B}/tasks/{ready}").json()["task"]["status"] == "ready"


def test_create_task_variants(kb):
    c, mock, _, audit = kb
    ready = c.post(f"{B}/tasks", json={"title": "Neu", "body": "Text", "assignee": "beta", "priority": 2}).json()["id"]
    todo = c.post(f"{B}/tasks", json={"title": "Später", "status": "todo"}).json()["id"]
    triage = c.post(f"{B}/tasks", json={"title": "Grob", "status": "triage"}).json()["id"]
    child = c.post(f"{B}/tasks", json={"title": "Kind", "parents": [ready]}).json()["id"]
    st = {t: c.get(f"{B}/tasks/{t}").json()["task"]["status"] for t in (ready, todo, triage, child)}
    assert st == {ready: "ready", todo: "todo", triage: "triage", child: "todo"}
    assert c.get(f"{B}/tasks/{ready}").json()["task"]["assignee"] == "beta"
    assert c.post(f"{B}/tasks", json={"title": "x", "status": "done"}).status_code == 422
    assert c.post(f"{B}/tasks", json={"title": ""}).status_code == 422
    assert c.post(f"{B}/tasks", json={"title": "x", "workspace_path": "/etc"}).status_code == 422  # extra=forbid
    assert c.post(f"{B}/tasks", json={"title": "x", "parents": ["t_nix"]}).status_code == 404
    assert 'kanban.task.create' in audit.read_text() and "Text" not in audit.read_text()


def test_update_move_and_errors(kb):
    c, mock, _, audit = kb
    assert c.patch(f"{B}/tasks/t_aaaa0003", json={"title": "Bericht v2", "body": "Neu", "priority": 3}).json() == {"ok": True}
    t = c.get(f"{B}/tasks/t_aaaa0003").json()["task"]
    assert (t["title"], t["body"], t["priority"]) == ("Bericht v2", "Neu", 3)
    assert c.patch(f"{B}/tasks/t_aaaa0003", json={"status": "review"}).json() == {"ok": True}
    assert c.get(f"{B}/tasks/t_aaaa0003").json()["task"]["status"] == "review"
    assert 'kanban.task.move' in audit.read_text() and 'kanban.task.update' in audit.read_text()
    # Dashboard verweigert: lesbarer Text kommt an
    r = c.patch(f"{B}/tasks/t_aaaa0004", json={"status": "ready"})
    assert r.status_code == 502 and "409" in r.json()["detail"] and "t_aaaa0003" in r.json()["detail"]
    assert c.patch(f"{B}/tasks/t_aaaa0003", json={"status": "running"}).status_code == 422  # keine Spalte dieses Boards? doch, aber Dashboard verweigert
    assert c.patch(f"{B}/tasks/t_aaaa0003", json={"status": "gibtsnicht"}).status_code == 422
    assert c.patch(f"{B}/tasks/t_aaaa0003", json={"status": "archived"}).status_code == 422
    assert c.patch(f"{B}/tasks/t_aaaa0003", json={}).status_code == 422
    assert c.patch(f"{B}/tasks/t_nix", json={"title": "x"}).status_code == 404
    assert c.patch(f"{B}/tasks/t_aaaa0003", json={"unbekannt": 1}).status_code == 422


def test_blocked_with_reason_and_done_with_summary(kb):
    c, mock, *_ = kb
    assert c.patch(f"{B}/tasks/t_aaaa0003", json={"status": "blocked", "block_reason": "Frage offen"}).json()["ok"]
    assert c.patch(f"{B}/tasks/t_aaaa0003", json={"status": "done", "summary": "Erledigt", "result": "ok"}).json()["ok"]
    t = c.get(f"{B}/tasks/t_aaaa0003").json()["task"]
    assert t["status"] == "done" and t["summary"] == "Erledigt" and t["result"] == "ok"


def test_comment_reassign_reclaim_links(kb):
    c, mock, _, audit = kb
    assert c.post(f"{B}/tasks/t_aaaa0003/comments", json={"body": "Hallo **Welt**"}).json() == {"ok": True}
    assert c.get(f"{B}/tasks/t_aaaa0003").json()["comments"][-1]["body"] == "Hallo **Welt**"
    assert c.post(f"{B}/tasks/t_aaaa0003/comments", json={"body": ""}).status_code == 422
    assert "Hallo" not in audit.read_text()
    assert c.post(f"{B}/tasks/t_aaaa0003/reassign", json={"assignee": "gamma"}).json() == {"ok": True}
    assert c.get(f"{B}/tasks/t_aaaa0003").json()["task"]["assignee"] == "gamma"
    assert c.post(f"{B}/tasks/t_aaaa0003/reassign", json={"assignee": ""}).json()["ok"]
    assert c.get(f"{B}/tasks/t_aaaa0003").json()["task"]["assignee"] is None
    assert c.post(f"{B}/tasks/t_aaaa0003/reassign", json={"assignee": "a/b"}).status_code == 422
    assert c.post(f"{B}/tasks/t_aaaa0003/reclaim").json()["detail"].startswith("Das Dashboard meldet Fehler 409")  # läuft nicht
    assert c.post(f"{B}/links", json={"parent_id": "t_aaaa0001", "child_id": "t_aaaa0003"}).json() == {"ok": True, "gated": False}
    assert c.get(f"{B}/tasks/t_aaaa0003").json()["links"]["parents"] == ["t_aaaa0001"]
    assert c.request("DELETE", f"{B}/links", params={"parent_id": "t_aaaa0001", "child_id": "t_aaaa0003"}).json() == {"ok": True}
    assert c.get(f"{B}/tasks/t_aaaa0003").json()["links"]["parents"] == []
    assert "400" in c.post(f"{B}/links", json={"parent_id": "t_aaaa0003", "child_id": "t_aaaa0003"}).json()["detail"]


def test_bulk_move_archive_and_rules(kb):
    c, mock, _, audit = kb
    r = c.post(f"{B}/tasks/bulk", json={"ids": ["t_aaaa0003", "t_nix"], "status": "review"}).json()["results"]
    assert r == [{"id": "t_aaaa0003", "ok": True, "error": None}, {"id": "t_nix", "ok": False, "error": "not found"}]
    assert c.post(f"{B}/tasks/bulk", json={"ids": ["t_aaaa0003"], "archive": True}).json()["results"][0]["ok"]
    assert "t_aaaa0003" not in json.dumps(c.get(f"{B}/board").json())
    assert "kanban.task.archive" in audit.read_text()
    assert c.post(f"{B}/tasks/bulk", json={"ids": ["t_aaaa0001"], "archive": True, "status": "todo"}).status_code == 422
    assert c.post(f"{B}/tasks/bulk", json={"ids": ["t_aaaa0001"]}).status_code == 422
    assert c.post(f"{B}/tasks/bulk", json={"ids": [], "archive": True}).status_code == 422
    assert c.post(f"{B}/tasks/bulk", json={"ids": ["t_aaaa0001"], "status": "archived"}).status_code == 422
    assert c.post(f"{B}/tasks/bulk", json={"ids": ["t_aaaa0001"], "status": "nix"}).status_code == 422
    assert c.post(f"{B}/tasks/bulk", json={"ids": ["t_aaaa0001"], "delete": True}).status_code == 422


def test_there_is_no_delete_route(kb):
    c, mock, app, _ = kb
    assert c.delete(f"{B}/tasks/t_aaaa0001").status_code == 405
    assert c.delete(f"{B}/boards/alpha").status_code == 405
    assert not [x for x in mock.state.calls if x[0] == "DELETE"]
    assert not [p for p in app.openapi()["paths"] if "_kanban" in p and "delete" in app.openapi()["paths"][p] and not p.endswith("/links")]


def test_boards_create_and_update(kb):
    c, mock, _, audit = kb
    r = c.post(f"{B}/boards", json={"slug": "neu", "name": "Neu", "description": "Test", "color": "#aabbcc"}).json()["board"]
    assert r["slug"] == "neu" and r["color"] == "#aabbcc" and "db_path" not in r
    assert c.post(f"{B}/boards", json={"slug": "neu", "name": "Neu"}).json()["detail"].endswith("board slug missing or exists")
    assert c.post(f"{B}/boards", json={"slug": "Gross/x", "name": "x"}).status_code == 422
    assert c.post(f"{B}/boards", json={"slug": "x2", "name": "x", "color": "rot"}).status_code == 422
    assert c.post(f"{B}/boards", json={"slug": "x3", "name": "x", "default_workdir": "/etc"}).status_code == 422
    assert c.patch(f"{B}/boards/neu", json={"name": "Anders"}).json()["board"]["name"] == "Anders"
    assert c.patch(f"{B}/boards/nix", json={"name": "A"}).status_code == 404
    assert c.patch(f"{B}/boards/neu", json={}).status_code == 422
    assert "kanban.board.create" in audit.read_text() and "kanban.board.update" in audit.read_text()
    # Aufgabe auf neuem Board: Board-Parameter wird durchgereicht
    tid = c.post(f"{B}/tasks", params={"board": "neu"}, json={"title": "Auf neu"}).json()["id"]
    assert [t["id"] for col in c.get(f"{B}/board", params={"board": "neu"}).json()["columns"] for t in col["tasks"]] == [tid]


@pytest.mark.parametrize("code,expected", [(500, 502), (503, 502), (404, 404), (401, 502)])
def test_dashboard_errors_become_readable_http_errors(kb, code, expected):
    c, mock, *_ = kb
    mock.state.fail = code
    r = c.get(f"{B}/board")
    assert r.status_code == expected and r.json()["detail"]
    assert c.post(f"{B}/tasks", json={"title": "x"}).status_code == expected


def test_auth_csrf_and_step_up(kb):
    c, mock, app, _ = kb
    anon = TestClient(app, headers=HDR)
    assert anon.get(f"{B}/boards").status_code == 401
    assert anon.post(f"{B}/tasks", json={"title": "x"}).status_code == 401
    no_csrf = TestClient(app, cookies=c.cookies)
    assert no_csrf.post(f"{B}/tasks", json={"title": "x"}).status_code in (400, 403)
    for sess in app.state.sessions._sessions.values():
        sess.auth_time = 0  # Anmeldung veraltet
    r = c.post(f"{B}/tasks", json={"title": "x"})
    assert r.status_code == 401 and r.json()["detail"]["code"] == "step_up_required"
    assert c.get(f"{B}/boards").status_code == 200  # Lesen braucht keine frische Anmeldung
