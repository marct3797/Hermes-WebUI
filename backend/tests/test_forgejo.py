import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.forgejo import ForgejoRegistry, parse_forgejo_config
from app.main import create_app
from devtools.mock_forgejo import TOKEN, create_mock as create_forgejo
from devtools.mock_hermes import create_mock as create_hermes
from tests.conftest import HDR, RouterTransport

F = "/bff/forgejo"


def cfg(**kw):
    return {"instances": [{"id": "fj", "label": "Forgejo", "base_url": "http://git.test", "token_env": "FJ_TOKEN", "repos": ["o/r"], "progress_labels": ["in-progress", "review"], **kw}]}


@pytest.fixture
def make(make_settings, tmp_path, monkeypatch):
    clients = []

    def build(config=None, token=TOKEN):
        if token is not None:
            monkeypatch.setenv("FJ_TOKEN", token)
        else:
            monkeypatch.delenv("FJ_TOKEN", raising=False)
        f = tmp_path / "forgejo.json"
        f.write_text(json.dumps(config or cfg()))
        fj = create_forgejo()
        t = RouterTransport({"hermes.test": httpx.ASGITransport(app=create_hermes()), "git.test": httpx.ASGITransport(app=fj)})
        c = TestClient(create_app(make_settings(forgejo_file=f), transport=t))
        c.__enter__()
        c.headers.update(HDR)
        c.fj = fj
        clients.append(c)
        return c
    yield build
    for c in clients:
        c.__exit__(None, None, None)


@pytest.mark.parametrize("raw", [
    [], {"instances": "x"}, {"instances": [1]},
    cfg(id="Bad Id")["instances"] and {"instances": [{**cfg()["instances"][0], "id": "Bad Id"}]},
    {"instances": [{**cfg()["instances"][0], "base_url": "ftp://x"}]},
    {"instances": [{**cfg()["instances"][0], "base_url": "http://u:p@x"}]},
    {"instances": [{**cfg()["instances"][0], "token_env": "ghp_geheimer-token"}]},
    {"instances": [{**cfg()["instances"][0], "repos": []}]},
    {"instances": [{**cfg()["instances"][0], "repos": ["../x/y"]}]},
    {"instances": [{**cfg()["instances"][0], "progress_labels": ["closed"]}]},
    {"instances": [cfg()["instances"][0], cfg()["instances"][0]]},
])
def test_config_rejects(raw):
    with pytest.raises(ValueError):
        parse_forgejo_config(raw)


def test_registry_missing_and_bad_file(tmp_path):
    assert ForgejoRegistry(None).instances() == {}
    f = tmp_path / "f.json"
    reg = ForgejoRegistry(f)
    assert reg.instances() == {} and reg.error is None
    f.write_text(json.dumps(cfg()))
    assert "fj" in reg.instances()
    f.write_text("{kaputt")
    import os, time
    os.utime(f, (time.time() + 5, time.time() + 5))
    assert "fj" in reg.instances() and "forgejo.json" in reg.error


def test_list_instances_never_leaks_token(make):
    c = make()
    r = c.get(F).json()
    assert r["instances"][0]["columns"] == ["open", "in-progress", "review", "closed"] and r["instances"][0]["token_set"] is True
    assert TOKEN not in json.dumps(r)
    assert make(token=None).get(F).json()["instances"][0]["token_set"] is False


def test_issues_columns_and_no_pull_requests(make):
    r = make().get(f"{F}/fj/issues", params={"repo": "o/r"}).json()
    cols = {i["number"]: i["column"] for i in r["issues"]}
    assert cols == {1: "open", 2: "in-progress", 3: "closed"}  # PR #4 fehlt
    assert r["truncated"] is False


def test_repo_must_be_allowlisted_and_instance_known(make):
    c = make()
    assert c.get(f"{F}/fj/issues", params={"repo": "evil/repo"}).status_code == 404
    assert c.get(f"{F}/fj/issues", params={"repo": "../etc"}).status_code == 422
    assert c.get(f"{F}/nope/issues", params={"repo": "o/r"}).status_code == 404


def test_missing_token_gives_clear_503_without_calling_forgejo(make):
    c = make(token=None)
    r = c.get(f"{F}/fj/issues", params={"repo": "o/r"})
    assert r.status_code == 503 and "FJ_TOKEN" in r.json()["detail"] and c.fj.state.calls == []


def test_wrong_token_is_reported_not_leaked(make):
    r = make(token="falsch").get(f"{F}/fj/issues", params={"repo": "o/r"})
    assert r.status_code == 502 and "falsch" not in r.text


def test_issue_detail_has_comments(make):
    d = make().get(f"{F}/fj/issues/2", params={"repo": "o/r"}).json()
    assert d["body"] == "Text zu In Arbeit" and d["comment_list"][0]["body"] == "Erster Kommentar"
    assert make().get(f"{F}/fj/issues/4", params={"repo": "o/r"}).status_code == 404  # Pull-Request ist kein Issue


def test_create_update_move_comment(make):
    c = make()
    n = c.post(f"{F}/fj/issues", params={"repo": "o/r"}, json={"title": "Neu", "body": "x", "assignee": "marc"}).json()
    assert n["number"] == 5 and n["assignee"] == "marc" and n["column"] == "open"
    p = c.patch(f"{F}/fj/issues/5", params={"repo": "o/r"}, json={"column": "review"}).json()
    assert p["column"] == "review" and [lb["name"] for lb in p["labels"]] == ["review"]
    p = c.patch(f"{F}/fj/issues/5", params={"repo": "o/r"}, json={"column": "in-progress"}).json()
    assert [lb["name"] for lb in p["labels"]] == ["in-progress"]  # altes Fortschritts-Label entfernt
    p = c.patch(f"{F}/fj/issues/5", params={"repo": "o/r"}, json={"column": "closed"}).json()
    assert p["state"] == "closed" and p["column"] == "closed" and p["labels"] == []
    p = c.patch(f"{F}/fj/issues/5", params={"repo": "o/r"}, json={"column": "open"}).json()
    assert p["state"] == "open" and p["column"] == "open"
    assert c.post(f"{F}/fj/issues/5/comments", params={"repo": "o/r"}, json={"body": "Hallo"}).status_code == 201
    assert c.get(f"{F}/fj/issues/5", params={"repo": "o/r"}).json()["comment_list"][0]["body"] == "Hallo"


def test_move_keeps_foreign_labels(make):
    c = make()
    c.fj.state.issues["o/r"][0]["labels"] = [{"name": "bug", "color": "f00"}]
    p = c.patch(f"{F}/fj/issues/1", params={"repo": "o/r"}, json={"column": "review"}).json()
    assert sorted(lb["name"] for lb in p["labels"]) == ["bug", "review"]


def test_bad_patch_inputs(make):
    c = make()
    assert c.patch(f"{F}/fj/issues/1", params={"repo": "o/r"}, json={}).status_code == 422
    assert c.patch(f"{F}/fj/issues/1", params={"repo": "o/r"}, json={"column": "gibtsnicht"}).status_code == 422
    assert c.patch(f"{F}/fj/issues/1", params={"repo": "o/r"}, json={"state": "closed"}).status_code == 422  # extra=forbid
    assert c.patch(f"{F}/fj/issues/99", params={"repo": "o/r"}, json={"title": "x"}).status_code == 404


def test_writes_are_audited_without_text(make, tmp_path):
    c = make()
    c.post(f"{F}/fj/issues/1/comments", params={"repo": "o/r"}, json={"body": "geheimer Text"})
    log = (tmp_path / "audit.log").read_text()
    assert "forgejo.issue.comment" in log and "geheimer Text" not in log


def test_requires_login(make):
    c = make()
    c.headers.pop("X-Requested-With", None)
    assert c.post(f"{F}/fj/issues", params={"repo": "o/r"}, json={"title": "x"}).status_code in (401, 403)
