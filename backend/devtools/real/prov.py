"""Gleiche Prüfung wie drive.py, aber für die Anbieter-Routen gegen ein echtes Hermes-Dashboard (Port 9123, Token dashtok-0123456789abcdef) und ein Gateway auf 8651."""
import json, os, sys
from pathlib import Path
from fastapi.testclient import TestClient
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from app.config import Settings
from app.main import create_app
SP = Path(os.environ.get("WORK", ".real")).resolve()
SP.mkdir(parents=True, exist_ok=True)
hosts = {"hosts": [{"id": "lokal", "label": "Lokal", "kind": "local", "runtimes": [
    {"id": "hermes", "base_url": "http://127.0.0.1:8651", "api_key": "testkey-sora-0123456789abcdef", "multiplex": False,
     "dashboard": {"base_url": "http://127.0.0.1:9123", "token": "dashtok-0123456789abcdef"}, "agents": [{"id": "default", "label": "Sora"}]}]}]}
(SP / "hosts2.json").write_text(json.dumps(hosts))
s = Settings(env="dev", hosts_file=SP / "hosts2.json", audit_file=SP / "audit2.log", rooms_db=SP / "rooms2.db", runs_per_minute=1000, soul_dir=SP / "soul2")
with TestClient(create_app(s)) as c:
    c.headers["X-Requested-With"] = "hermes-webui"
    m = c.get("/bff/h/lokal/hermes/_provider-matrix").json()
    print(json.dumps({k: m[k] for k in ("available", "reason", "profiles")}, ensure_ascii=False))
    for a in m["accounts"]: print(a["id"], a["profiles"])
    mo = c.get("/bff/h/lokal/hermes/default/providers/models").json()
    print([(p["slug"], p["current"], p["authenticated"], len(p["models"])) for p in mo["providers"]][:8])
    r = c.post("/bff/h/lokal/hermes/default/providers/oauth/openai-codex/start")
    print("codex start:", r.status_code, r.text[:300])
    r = c.post("/bff/h/lokal/hermes/default/providers/oauth/anthropic/start")
    print("anthropic start:", r.status_code, r.text[:300])
