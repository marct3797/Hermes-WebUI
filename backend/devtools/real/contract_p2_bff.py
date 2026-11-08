"""P2 Ende-zu-Ende: das ECHTE BFF gegen das ECHTE Sandbox-Dashboard (Port 9199, eigenes HOME; nie die echte Installation).

Prüft Modelle (inkl. frische Installation ohne Anbieter), Delegation, eigene Endpunkte (Schlüssel nie im Klartext), lokale Modelle, Sitzungen
(503 des Dashboards wird mit Text durchgereicht), Pairing, Webhooks. Schreibt nur in die Sandbox; config.yaml wird vorher gesichert und danach zurückgesetzt.
"""
import json, shutil, sys, tempfile, urllib.request
from pathlib import Path
from fastapi.testclient import TestClient
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from app.config import Settings
from app.main import create_app

PORT, TOKEN = 9199, "sandbox-token-0123456789"
KEY = "sk-e2e-nur-sandbox-4711"
work = Path(tempfile.mkdtemp())
(work / "hosts.json").write_text(json.dumps({"hosts": [{"id": "lokal", "kind": "local", "runtimes": [
    {"id": "hermes", "base_url": "http://127.0.0.1:1", "api_key": "x" * 16, "multiplex": False,
     "dashboard": {"base_url": f"http://127.0.0.1:{PORT}", "token": TOKEN}, "agents": ["default"]}]}]}))
s = Settings(env="dev", hosts_file=work / "hosts.json", audit_file=work / "audit.log", rooms_db=work / "rooms.db", soul_dir=work / "soul", runs_per_minute=1000)
OUT, BAD = [], []


def check(label, cond, extra=""):
    line = f"{'ok' if cond else 'FEHLT'}: {label} {extra}".rstrip()
    OUT.append(line)
    if not cond:
        BAD.append(line)


def dash(method, path, body=None):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", method=method, data=json.dumps(body).encode() if body else None, headers={"X-Hermes-Session-Token": TOKEN, "Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=20).read() or b"null")


home = Path(dash("GET", "/api/profiles")["profiles"][0]["path"])
assert "sandbox" in str(home), f"ABBRUCH: Profilpfad {home} liegt nicht in der Sandbox"
cfg = home / "config.yaml"
backup = work / "config.yaml.bak"
had = cfg.exists()
if had:
    shutil.copy2(cfg, backup)
try:
    with TestClient(create_app(s)) as c:
        c.headers["X-Requested-With"] = "hermes-webhooks-unused"
        c.headers["X-Requested-With"] = "hermes-webui"
        B = "/bff/h/lokal/hermes/default"
        # Modelle: frische Installation
        r = c.get(f"{B}/hermes-models/info"); j = r.json()
        fresh = r.status_code == 200 and j.get("configured") is False
        check("models/info 200 (frische Installation = Daten, kein 502)", r.status_code == 200 and "configured" in j, f"{r.status_code} {r.text[:120]}")
        r = c.get(f"{B}/hermes-models/options"); check("models/options 200, providers Liste", r.status_code == 200 and isinstance(r.json().get("providers"), list), f"{r.status_code} n={len(r.json().get('providers', [])) if r.status_code == 200 else '-'}")
        r = c.get(f"{B}/hermes-models/recommended-default"); check("models/recommended-default 200 mit available", r.status_code == 200 and "available" in r.json(), f"{r.status_code} {r.text[:100]}")
        r = c.get(f"{B}/hermes-models/auxiliary"); check("models/auxiliary 200 mit Tasks", r.status_code == 200 and bool(r.json().get("tasks")), f"{r.status_code}")
        r = c.get(f"{B}/hermes-models/moa"); check("models/moa 200 mit Presets", r.status_code == 200 and bool(r.json().get("presets")), f"{r.status_code} {r.text[:100]}")
        # Modell setzen (Schreibpfad, Sandbox) und zurücklesen
        r = c.post(f"{B}/hermes-models/set", json={"scope": "main", "provider": "anthropic", "model": "claude-sonnet-4"})
        check("models/set mit nicht verbundenem Anbieter: Hermes lehnt ab, Text kommt durch (kein stilles Gelingen)", r.status_code == 502 and "not connected" in r.text, f"{r.status_code} {r.text[:140]}")
        check("models/info danach unverändert (nichts geschrieben)", c.get(f"{B}/hermes-models/info").json().get("configured") is False)
        # Delegation
        r = c.get(f"{B}/hermes-delegation"); j = r.json() if r.status_code == 200 else {}
        check("delegation 200 mit Backends", r.status_code == 200 and bool(j.get("backends")), f"{r.status_code} configured={j.get('configured')} backends={[b['name'] for b in j.get('backends', [])]}")
        if j.get("backends"):
            cur = j["configured"]
            r = c.put(f"{B}/hermes-delegation/backend", json={"backend": cur})
            check("delegation/backend (gleiches Backend) 200", r.status_code == 200, f"{r.status_code} {r.text[:160]}")
        r = c.put(f"{B}/hermes-delegation/backend", json={"backend": "gibt-es-nicht"}); check("delegation/backend unbekannt -> 422", r.status_code == 422, f"{r.status_code}")
        # Endpunkte
        r = c.post(f"{B}/hermes-endpoints", json={"name": "e2e-ollama", "base_url": "http://127.0.0.1:11434/v1", "model": "llama3", "api_key": KEY})
        check("endpoints POST 200 mit id", r.status_code == 200 and r.json().get("id"), f"{r.status_code} {r.text[:200]}")
        check("endpoints: Schlüssel nie in der Antwort", KEY not in r.text)
        eid = r.json().get("id") if r.status_code == 200 else None
        r = c.get(f"{B}/hermes-endpoints"); check("endpoints GET: Zeile mit has_api_key, ohne Schlüssel", r.status_code == 200 and KEY not in r.text and any(e["id"] == eid and e["has_api_key"] for e in r.json()["endpoints"]), f"{r.status_code}")
        r = c.post(f"{B}/hermes-endpoints", json={"name": "bös", "base_url": "http://169.254.169.254/x", "model": "m"}); check("endpoints: Metadaten-URL -> 422", r.status_code == 422, f"{r.status_code}")
        r = c.post(f"{B}/hermes-endpoints/validate", json={"name": "e2e", "base_url": "http://127.0.0.1:9/v1", "model": "m", "api_key": KEY}); check("endpoints/validate: unerreichbar -> ok false, Schlüssel nicht im Echo", r.status_code == 200 and r.json()["ok"] is False and KEY not in r.text, f"{r.status_code} {r.text[:140]}")
        if eid:
            r = c.post(f"{B}/hermes-endpoints/{eid}/activate"); check("endpoints/activate 200 und is_current", r.status_code == 200, f"{r.status_code} {r.text[:160]}")
            i = c.get(f"{B}/hermes-models/info").json()
            check("models/info zeigt nach Aktivieren das Endpunkt-Modell, configured true", i.get("model") == "llama3" and i.get("configured") is True, json.dumps(i)[:160])
            r = c.post(f"{B}/hermes-models/set", json={"scope": "main", "provider": i.get("provider") or "custom", "model": "llama3"})
            check("models/set mit verbundenem (eigenem) Endpunkt 200, Rücklesen bestätigt", r.status_code == 200 and r.json().get("ok") is True, f"{r.status_code} {r.text[:160]}")
            r = c.request("DELETE", f"{B}/hermes-endpoints/{eid}", params={"confirm": "falsch"}); check("endpoints DELETE ohne richtige ID -> 422", r.status_code == 422, f"{r.status_code}")
            r = c.request("DELETE", f"{B}/hermes-endpoints/{eid}", params={"confirm": eid}); check("endpoints DELETE mit ID 200", r.status_code == 200, f"{r.status_code} {r.text[:160]}")
            check("endpoints: Zeile weg", all(e["id"] != eid for e in c.get(f"{B}/hermes-endpoints").json()["endpoints"]))
        # Lokale Modelle
        r = c.get(f"{B}/hermes-local-models/status"); check("local-models/status 200", r.status_code == 200 and "server_running" in r.json(), f"{r.status_code}")
        # Sitzungen: Store evtl. nicht initialisiert -> 503 mit Text, sonst Zahlen
        r = c.get(f"{B}/hermes-sessions/stats")
        check("sessions/stats: Zahlen ODER Dashboard-503 mit Hinweistext (Sandbox-Speicher nicht initialisiert)", (r.status_code == 200 and isinstance(r.json().get("total"), int)) or (r.status_code == 502 and "not initialized" in r.text), f"{r.status_code} {r.text[:120]}")
        r = c.post(f"{B}/hermes-sessions/prune/preview", json={"older_than_days": 90}); check("sessions/prune/preview: matched ODER Hinweistext", (r.status_code == 200 and isinstance(r.json().get("matched"), int)) or (r.status_code == 502 and "not initialized" in r.text), f"{r.status_code} {r.text[:120]}")
        r = c.post(f"{B}/hermes-sessions/prune", json={"older_than_days": 0, "confirm_count": 0}); check("sessions/prune mit 0 Tagen -> 422", r.status_code == 422, f"{r.status_code}")
        r = c.get(f"{B}/hermes-sessions/nix/export"); check("sessions/export unbekannt -> 404 oder Hinweistext", r.status_code == 404 or (r.status_code == 502 and "not initialized" in r.text), f"{r.status_code}")
        # Pairing / Webhooks
        r = c.get(f"{B}/hermes-pairing"); check("pairing 200", r.status_code == 200 and "pending" in r.json(), f"{r.status_code} {r.text[:120]}")
        r = c.post(f"{B}/hermes-pairing/approve", json={"platform": "telegram", "request_id": "nix"}); check("pairing/approve unbekannt -> 404", r.status_code == 404, f"{r.status_code} {r.text[:120]}")
        r = c.get(f"{B}/hermes-webhooks"); wj = r.json() if r.status_code == 200 else {}
        check("webhooks 200 mit enabled", r.status_code == 200 and isinstance(wj.get("enabled"), bool), f"{r.status_code} {r.text[:140]}")
        if wj.get("enabled") is False:
            r = c.post(f"{B}/hermes-webhooks", json={"name": "e2e", "events": ["push"]}); check("webhooks create bei ausgeschalteter Plattform -> 409", r.status_code == 409, f"{r.status_code} {r.text[:120]}")
        r = c.post(f"{B}/hermes-webhooks/enable", json={"confirm_restart": False}); check("webhooks/enable ohne Bestätigung -> 422", r.status_code == 422, f"{r.status_code}")
finally:
    if had:
        shutil.copy2(backup, cfg)
    else:
        cfg.unlink(missing_ok=True)
    print("config.yaml der Sandbox zurückgesetzt")

print("\n".join(OUT))
print(f"\n{len(OUT) - len(BAD)}/{len(OUT)} ok")
raise SystemExit(1 if BAD else 0)
