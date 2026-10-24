"""Einstellungs-Editor gegen ein ECHTES Hermes-Dashboard (Sandbox-HOME, nie die echte Installation).

    SB=$(mktemp -d); env -i PATH=$PATH HOME=$SB HERMES_HOME=$SB/.hermes HERMES_DASHBOARD_SESSION_TOKEN=sandbox-token-0123456789 \\
        hermes dashboard --port 9199 --no-open --skip-build &
    python -m devtools.real.contract_config

Das Dashboard liest sonst ueber HERMES_REAL_HOME das echte ~/.hermes: HOME UND HERMES_HOME muessen auf die Sandbox zeigen, sonst nichts schreiben.
"""
import json, sys, tempfile
from pathlib import Path
from fastapi.testclient import TestClient
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from app.config import Settings
from app.main import create_app

PORT, TOKEN = 9199, "sandbox-token-0123456789"
work = Path(tempfile.mkdtemp())
(work / "hosts.json").write_text(json.dumps({"hosts": [{"id": "lokal", "kind": "local", "runtimes": [
    {"id": "hermes", "base_url": "http://127.0.0.1:1", "api_key": "x" * 16, "multiplex": False,
     "dashboard": {"base_url": f"http://127.0.0.1:{PORT}", "token": TOKEN}, "agents": ["default"]}]}]}))
s = Settings(env="dev", hosts_file=work / "hosts.json", audit_file=work / "audit.log", rooms_db=work / "rooms.db", soul_dir=work / "soul", runs_per_minute=1000)
with TestClient(create_app(s)) as c:
    c.headers["X-Requested-With"] = "hermes-webui"
    base = "/bff/h/lokal/hermes/default"
    home = c.get(f"{base}/dashboard").json()
    path = (home.get("profile") or {})
    print("dashboard:", {k: home.get(k) for k in ("available", "reason")}, "| HOME-Pruefung:", c.get(f"{base}/config").status_code)
    r = c.get(f"{base}/config"); body = r.json()
    f = {x["key"]: x for x in body["fields"]}
    from collections import Counter
    print("Felder:", len(f), dict(Counter(x["type"] for x in f.values())), "| Geheimnisse:", sum(1 for x in f.values() if x.get("secret")), "| Bereiche:", body["category_order"][:6])
    leak = [k for k, x in f.items() if x.get("secret") and x.get("value") is not None]
    print("Geheimnisfelder mit Wert in der Antwort:", leak)
    # echte Schreibprobe auf drei Typen, danach zuruecksetzen
    probe = {"agent.max_turns": f["agent.max_turns"]["value"] if "agent.max_turns" in f else None}
    key_num = next(k for k, x in f.items() if x["type"] == "number" and not x.get("secret") and isinstance(x.get("value"), (int, float)))
    key_bool = next(k for k, x in f.items() if x["type"] == "boolean" and isinstance(x.get("value"), bool))
    key_sel = next((k for k, x in f.items() if x["type"] == "select" and x.get("options") and len(x["options"]) > 1), None)
    orig = {k: f[k]["value"] for k in (key_num, key_bool) + ((key_sel,) if key_sel else ())}
    new = {key_num: orig[key_num] + 1, key_bool: not orig[key_bool]}
    if key_sel:
        new[key_sel] = next(o for o in f[key_sel]["options"] if o != orig[key_sel])
    w = c.put(f"{base}/config", json={"changes": new})
    print("PUT:", w.status_code, w.text[:200])
    after = {x["key"]: x["value"] for x in c.get(f"{base}/config").json()["fields"] if x["key"] in new}
    print("gelesen == geschrieben:", after == new, {k: (orig[k], after.get(k)) for k in new})
    back = c.put(f"{base}/config", json={"changes": orig}); print("zurueck:", back.status_code, back.text[:120])
    # Listen und unbekannte Schluessel
    lst = next((k for k, x in f.items() if x["type"] == "list"), None)
    print("Liste-Feld:", lst, "| Wert:", json.dumps(f[lst]["value"])[:80] if lst else None)
    print("Schema ohne Wert (None):", sum(1 for x in f.values() if not x.get("secret") and x.get("value") is None), "von", len(f))
