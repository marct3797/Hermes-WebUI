"""BFF: Bot-Modus-Peers über den Host-Dienst. Der Schlüssel geht nie zurück; Schreiben mit frischer Anmeldung und Rücklesen; Senden nur an eingetragene Peers."""
from fastapi import FastAPI, HTTPException

from tests.test_memfiles_bff import TOKEN, logged

BASE = "/bff/h/server/hermes/default"
SEEN: list = []


def hostd(mode="ok"):
    app = FastAPI()
    state = {"peers": {"spark": {"name": "spark", "url": "http://spark.lan:8377", "note": "", "has_key": True, "key": "LEAK"}, "nokey": {"name": "nokey", "url": "http://x.lan", "note": "", "has_key": False}}}

    @app.post("/v1/profiles/{profile}/peers")
    async def peers(profile: str, body: dict):
        SEEN.append(body)
        a = body["action"]
        if mode == "old":
            raise HTTPException(404, "intern: /home/geheim")
        if mode == "forbidden":
            raise HTTPException(403, "intern: /home/geheim")
        if a == "list":
            return {"peers": list(state["peers"].values())}
        if a == "add":
            if mode != "drop":
                state["peers"][body["name"]] = {"name": body["name"], "url": body["url"].rstrip("/"), "note": body["note"], "has_key": bool(body["key"]) or body["name"] in state["peers"] and state["peers"][body["name"]]["has_key"]}
            return {"ok": True, "result": None, "output": "", "error": ""}
        if a == "remove":
            if mode != "keep":
                state["peers"].pop(body["name"], None)
            return {"ok": True, "result": None, "output": "", "error": ""}
        if a == "run":
            if mode == "norun":
                return {"ok": False, "result": None, "output": "", "error": "Could not reach peer"}
            return {"ok": True, "result": {"peer": "spark", "profile": None, "session_id": "s1", "run_id": "run_1", "status": "started", "replayed": False, "idempotency_key": "peer-x", "secret": "LEAK"}, "output": "", "error": ""}
        if a == "status":
            return {"ok": True, "result": {"run_id": body["run_id"], "status": "completed", "output": "Antwort"}, "output": "", "error": ""}
        if a == "stop":
            return {"ok": mode != "nostop", "result": {"run_id": body["run_id"], "status": "stopped"}, "output": "", "error": "nope"}
    return app


def make(tmp_path, make_settings, monkeypatch, mode="ok"):
    monkeypatch.setenv("TEST_HOSTD", TOKEN)
    SEEN.clear()
    return logged(tmp_path, make_settings, hostd(mode))


def stale(c):
    from app.auth import SESSION_COOKIE
    c.app.state.sessions.get(c.cookies.get(SESSION_COOKIE)).auth_time = 0


def test_list_never_has_the_key(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch):
        body = c.get(f"{BASE}/peers").json()
        assert [p["name"] for p in body["peers"]] == ["spark", "nokey"] and "LEAK" not in str(body) and "key" not in body["peers"][0]


def test_hostd_problems_become_clear_errors(tmp_path, make_settings, monkeypatch):
    for mode, status in (("old", 404), ("forbidden", 403)):
        for c in make(tmp_path, make_settings, monkeypatch, mode):
            r = c.get(f"{BASE}/peers")
            assert r.status_code == status and "geheim" not in r.text


def test_add_is_verified_audited_without_key_and_needs_fresh_login(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch):
        r = c.post(f"{BASE}/peers", json={"name": "lab", "url": "http://lab.lan:8377/", "key": "TOPSECRET-KEY", "note": "Labor"})
        assert r.status_code == 200 and r.json()["peer"]["url"] == "http://lab.lan:8377" and "TOPSECRET" not in r.text
        assert any(s.get("key") == "TOPSECRET-KEY" for s in SEEN)
        log = c.audit_file.read_text()
        assert "peers.add" in log and "TOPSECRET" not in log
        stale(c)
        n = len(SEEN)
        assert c.post(f"{BASE}/peers", json={"name": "lab2", "url": "http://lab.lan", "key": "k"}).status_code == 401 and len(SEEN) == n


def test_add_needs_a_key_for_new_peers_but_not_for_updates(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch):
        assert c.post(f"{BASE}/peers", json={"name": "neu", "url": "http://neu.lan"}).status_code == 422
        assert c.post(f"{BASE}/peers", json={"name": "spark", "url": "http://spark.lan:9000"}).status_code == 200
        assert c.post(f"{BASE}/peers", json={"name": "Bad Name", "url": "http://x.lan", "key": "k"}).status_code == 422
        assert c.post(f"{BASE}/peers", json={"name": "neu", "url": "http://neu.lan", "key": "k", "extra": 1}).status_code == 422


def test_add_not_taken_over_is_502(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch, "drop"):
        assert c.post(f"{BASE}/peers", json={"name": "lab", "url": "http://lab.lan", "key": "k"}).status_code == 502
        assert "verified" in c.audit_file.read_text()


def test_remove_needs_the_name_and_is_read_back(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch):
        assert c.delete(f"{BASE}/peers/spark").status_code == 422
        assert c.delete(f"{BASE}/peers/nix", params={"confirm": "nix"}).status_code == 404
        assert c.delete(f"{BASE}/peers/spark", params={"confirm": "spark"}).json() == {"ok": True}
        assert [p["name"] for p in c.get(f"{BASE}/peers").json()["peers"]] == ["nokey"]
    for c in make(tmp_path, make_settings, monkeypatch, "keep"):
        assert c.delete(f"{BASE}/peers/spark", params={"confirm": "spark"}).status_code == 502


def test_send_only_to_registered_peers_with_key_and_audit_has_no_text(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch):
        r = c.post(f"{BASE}/peers/send", json={"target": "spark/researcher", "message": "Geheimer Auftragstext"})
        assert r.status_code == 200 and r.json()["run_id"] == "run_1" and "secret" not in r.json() and "LEAK" not in r.text
        assert SEEN[-1]["message"] == "Geheimer Auftragstext"
        log = c.audit_file.read_text()
        assert "peers.send" in log and "Geheimer Auftragstext" not in log
        n = len(SEEN)
        for body in ({"target": "unbekannt", "message": "x"}, {"target": "nokey", "message": "x"}):
            assert c.post(f"{BASE}/peers/send", json=body).status_code == 422
        for body in ({"target": "../x", "message": "x"}, {"target": "spark", "message": ""}, {"target": "spark", "message": "  "}, {"target": "spark", "message": "x", "idempotency_key": "a b"}):
            assert c.post(f"{BASE}/peers/send", json=body).status_code == 422
        assert [s["action"] for s in SEEN[n:]] == ["list", "list"]
        stale(c)
        assert c.post(f"{BASE}/peers/send", json={"target": "spark", "message": "x"}).status_code == 401


def test_send_without_run_id_is_502(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch, "norun"):
        r = c.post(f"{BASE}/peers/send", json={"target": "spark", "message": "x"})
        assert r.status_code == 502 and "verified" in c.audit_file.read_text()


def test_status_and_stop(tmp_path, make_settings, monkeypatch):
    for c in make(tmp_path, make_settings, monkeypatch):
        r = c.post(f"{BASE}/peers/status", json={"target": "spark", "run_id": "run_1"}).json()
        assert r["status"] == "completed" and r["output"] == "Antwort"
        assert c.post(f"{BASE}/peers/status", json={"target": "spark", "run_id": "a/b"}).status_code == 422
        assert c.post(f"{BASE}/peers/stop", json={"target": "spark", "run_id": "run_1"}).json()["status"] == "stopped"
    for c in make(tmp_path, make_settings, monkeypatch, "nostop"):
        assert c.post(f"{BASE}/peers/stop", json={"target": "spark", "run_id": "run_1"}).status_code == 502
