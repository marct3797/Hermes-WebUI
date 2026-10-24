"""Gedaechtnis-Routen gegen ein ECHTES Hermes-Dashboard (Sandbox-HOME). Aufbau wie contract_config.py. Schreibt einen erfundenen Key und raeumt auf."""
import json, sys, tempfile, urllib.request
from pathlib import Path
from fastapi.testclient import TestClient
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from app.config import Settings
from app.main import create_app

PORT, TOKEN, FAKE = 9199, "sandbox-token-0123456789", "rdb-nur-sandbox-0815"
work = Path(tempfile.mkdtemp())
(work / "hosts.json").write_text(json.dumps({"hosts": [{"id": "lokal", "kind": "local", "runtimes": [
    {"id": "hermes", "base_url": "http://127.0.0.1:1", "api_key": "x" * 16, "multiplex": False, "dashboard": {"base_url": f"http://127.0.0.1:{PORT}", "token": TOKEN}, "agents": ["default"]}]}]}))
s = Settings(env="dev", hosts_file=work / "hosts.json", audit_file=work / "audit.log", rooms_db=work / "rooms.db", soul_dir=work / "soul", runs_per_minute=1000)


def dash(method, path, body=None):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", method=method, data=json.dumps(body).encode() if body else None, headers={"X-Hermes-Session-Token": TOKEN, "Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=20).read() or b"null")


assert "sandbox" in dash("GET", "/api/profiles")["profiles"][0]["path"], "ABBRUCH: Profilpfad liegt nicht in der Sandbox"
print("Sandbox-Pfad geprueft")
with TestClient(create_app(s)) as c:
    c.headers["X-Requested-With"] = "hermes-webui"
    H = "/bff/h/lokal/hermes/default/hermes-memory"
    o = c.get(H); b = o.json(); print("Uebersicht:", o.status_code, b["active"] == "", b["files"], [(p["name"], p["status"], p["required_env"], [m["name"] for m in p["missing"]]) for p in b["providers"]])
    f = c.get(f"{H}/providers/retaindb").json()["fields"]; print("retaindb Felder:", [(x["key"], x["kind"], x["is_set"], "value" in x) for x in f])
    bad = c.put(f"{H}/providers/retaindb", json={"values": {"nope": "x"}}); print("unbekanntes Feld:", bad.status_code)
    w = c.put(f"{H}/providers/retaindb", json={"values": {"api_key": FAKE}}); print("Key setzen:", w.status_code, w.text[:120], "| Key in Antwort:", FAKE in w.text)
    print("danach aktiv:", c.get(H).json()["active"], "| Key in Lese-Antwort:", FAKE in c.get(f"{H}/providers/retaindb").text)
    print("byterover (Programm fehlt) aktivieren:", c.put(f"{H}/provider", json={"provider": "byterover"}).status_code)
    print("zurueck auf eingebaut:", c.put(f"{H}/provider", json={"provider": ""}).status_code, "aktiv =", repr(c.get(H).json()["active"]))
    print("Reset ohne Bestaetigung:", c.post(f"{H}/reset", json={"target": "user"}).status_code)
    r = c.post(f"{H}/reset", json={"target": "user", "confirm": "user"}); print("Reset user (Sandbox):", r.status_code, r.text[:100])
    print("setup-Route:", c.post(f"{H}/providers/byterover/setup", json={}).status_code)
try:
    dash("DELETE", "/api/env", {"key": "RETAINDB_API_KEY"}); print("Aufgeraeumt")
except Exception as e:
    print("Aufraeumen:", e)
print("Audit:", [l.split('"action":"')[1].split('"')[0] for l in (work / "audit.log").read_text().splitlines()], "| Key im Audit:", FAKE in (work / "audit.log").read_text())
