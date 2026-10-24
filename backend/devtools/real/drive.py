"""Raum mit zwei ECHTEN Hermes-Gateways (Code aus dem Hermes-Paket, Modell = fakellm.py) durch das echte BFF."""
import json, os, sys, time
from pathlib import Path
from fastapi.testclient import TestClient
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from app.config import Settings
from app.main import create_app

SP = Path(os.environ.get("WORK", ".real")).resolve()
SP.mkdir(parents=True, exist_ok=True)
hosts = {"hosts": [
    {"id": f"h-{n}", "label": n.title(), "kind": "remote", "address": "127.0.0.1", "runtimes": [
        {"id": "hermes", "base_url": f"http://127.0.0.1:{port}", "api_key": f"testkey-{n}-0123456789abcdef", "multiplex": False,
         "agents": [{"id": "default", "label": n.title()}]}]}
    for n, port in (("eta", 8651), ("beta", 8652))]}
(SP / "hosts.json").write_text(json.dumps(hosts))
db = SP / "rooms.db"
db.unlink(missing_ok=True)
s = Settings(env="dev", hosts_file=SP / "hosts.json", audit_file=SP / "audit.log", rooms_db=db, runs_per_minute=1000, soul_dir=SP / "soul")
text = sys.argv[1] if len(sys.argv) > 1 else "Hallo zusammen, bitte prüft die Config."
with TestClient(create_app(s)) as c:
    c.headers["X-Requested-With"] = "hermes-webui"
    print(c.get("/bff/hosts").json()["hosts"][0]["status"], c.get("/bff/hosts").json()["hosts"][1]["status"])
    room = c.post("/bff/rooms", json={"name": "Test", "members": [{"host": "h-eta", "runtime": "hermes", "agent": "default"}, {"host": "h-beta", "runtime": "hermes", "agent": "default"}]}).json()
    rid = room["id"]
    print(c.post(f"/bff/rooms/{rid}/messages", json={"text": text}).status_code)
    for _ in range(120):
        time.sleep(0.5)
        r = c.get(f"/bff/rooms/{rid}").json()
        if not r["running"]:
            break
    for m in r["messages"]:
        print(f"[{m['seq']}] {m['author']:>16} {m['kind']:7} {m['mentions']} {m['text']!r}")
