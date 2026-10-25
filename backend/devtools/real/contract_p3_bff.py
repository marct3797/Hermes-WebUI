"""P2-Reste und P3 Ende-zu-Ende: das ECHTE BFF gegen das ECHTE Sandbox-Dashboard (Port 9199, eigenes HOME; nie die echte Installation).

Prüft Schlüssel-Pools, Sprache, System, Curator, Lerngraph, Darstellung, Datenschutz, Achievements und Kanban-Diagnose.
Nur lesend oder rückstellend: config.yaml wird vorher gesichert und danach zurückgesetzt; Reset, Curator-Lauf, Dispatch und Metrik-Senden werden nicht ausgelöst.
"""
import json, shutil, sys, tempfile, urllib.request
from pathlib import Path
from fastapi.testclient import TestClient
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from app.config import Settings
from app.main import create_app

PORT, TOKEN = 9199, "sandbox-token-0123456789"
KEY = "sk-e2e-pool-sandbox-4711"
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
        c.headers["X-Requested-With"] = "hermes-webui"
        B, H = "/bff/h/lokal/hermes/default", "/bff/h/lokal"
        j = lambda r: r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        # Schlüssel-Pools
        r = c.get(f"{B}/hermes-credentials"); check("credentials GET 200, Liste (frisch: leer)", r.status_code == 200 and isinstance(j(r).get("providers"), list), f"{r.status_code} {r.text[:140]}")
        r = c.post(f"{B}/hermes-credentials", json={"provider": "openrouter", "api_key": KEY, "label": "e2e"}); check("credentials POST 200", r.status_code == 200 and j(r).get("count", 0) >= 1, f"{r.status_code} {r.text[:200]}")
        check("credentials: Schlüssel nie in der Antwort", KEY not in r.text)
        r = c.get(f"{B}/hermes-credentials"); body = r.text
        rows = [e for p in j(r).get("providers", []) if p["provider"] == "openrouter" for e in p["entries"]]
        check("credentials GET zeigt Eintrag, nur vier Zeichen", KEY not in body and any(e["token_tail"] == KEY[-4:] for e in rows), body[:200])
        mine = next((e for e in rows if e["token_tail"] == KEY[-4:]), None)
        if mine:
            r = c.request("DELETE", f"{B}/hermes-credentials/openrouter/{mine['index']}", params={"confirm": "falsch"}); check("credentials DELETE ohne Namen -> 422", r.status_code == 422, f"{r.status_code}")
            r = c.request("DELETE", f"{B}/hermes-credentials/openrouter/{mine['index']}", params={"confirm": "openrouter"}); check("credentials DELETE mit Namen 200", r.status_code == 200, f"{r.status_code} {r.text[:200]} source={mine['source']}")
        # Sprache
        r = c.get(f"{B}/hermes-voice/status"); check("voice/status 200 mit mode/available", r.status_code == 200 and "available" in j(r), f"{r.status_code} {r.text[:160]}")
        r = c.post(f"{B}/hermes-voice/transcribe", json={"data_url": "data:text/plain;base64,AAAA"}); check("voice/transcribe kein Audio -> 422", r.status_code == 422, f"{r.status_code}")
        r = c.post(f"{B}/hermes-voice/speak", json={"text": "Hallo"}); check("voice/speak: Audio ODER Hinweistext des Dashboards (kein Anbieter), nie 500", r.status_code in (200, 502, 501), f"{r.status_code} {r.text[:160]}")
        # System
        r = c.get(f"{B}/hermes-system"); check("system 200 mit Version, ohne env/home", r.status_code == 200 and j(r).get("hermes_version") and "env" not in j(r) and "home" not in j(r), f"{r.status_code} {r.text[:200]}")
        # Curator
        r = c.get(f"{B}/hermes-curator"); check("curator GET 200 mit paused", r.status_code == 200 and isinstance(j(r).get("paused"), bool), f"{r.status_code} {r.text[:200]}")
        was = j(r).get("paused")
        if isinstance(was, bool):
            r = c.put(f"{B}/hermes-curator/paused", json={"paused": not was}); check("curator/paused umschalten, Rücklesen bestätigt", r.status_code == 200, f"{r.status_code} {r.text[:160]}")
            r = c.put(f"{B}/hermes-curator/paused", json={"paused": was}); check("curator/paused zurückstellen", r.status_code == 200 and c.get(f"{B}/hermes-curator").json()["paused"] is was, f"{r.status_code}")
        r = c.post(f"{B}/hermes-curator/run", json={}); check("curator/run ohne Bestätigung -> 422", r.status_code == 422, f"{r.status_code}")
        r = c.get(f"{B}/hermes-curator/run"); check("curator/run Protokoll: 200 oder 404 'Noch kein Lauf'", r.status_code in (200, 404), f"{r.status_code} {r.text[:140]}")
        # Lerngraph
        r = c.get(f"{B}/hermes-learning"); g = j(r); check("learning 200 mit nodes/edges (frisch: leer oder Systemskills)", r.status_code == 200 and isinstance(g.get("nodes"), list) and isinstance(g.get("edges"), list), f"{r.status_code} n={len(g.get('nodes', []))} {r.text[:100] if r.status_code != 200 else ''}")
        check("learning: keine Pfade im Graph", "/home/" not in r.text and '"path"' not in r.text)
        r = c.get(f"{B}/hermes-learning/node", params={"id": "../etc/passwd"}); check("learning/node mit .. -> 422", r.status_code == 422, f"{r.status_code}")
        r = c.get(f"{B}/hermes-learning/node", params={"id": "gibt-es-nicht-4711"}); check("learning/node unbekannt -> 404", r.status_code == 404, f"{r.status_code} {r.text[:140]}")
        first = (g.get("nodes") or [{}])[0].get("id")
        if first:
            r = c.get(f"{B}/hermes-learning/node", params={"id": first}); check(f"learning/node '{first}' lesbar", r.status_code == 200 and isinstance(j(r).get("content"), str), f"{r.status_code} {r.text[:120]}")
        # Darstellung
        r = c.get(f"{B}/hermes-appearance"); a = j(r); check("appearance 200 mit Themes/Schrift", r.status_code == 200 and a.get("themes") and a.get("active"), f"{r.status_code} {r.text[:160]}")
        if a.get("themes"):
            r = c.put(f"{B}/hermes-appearance/theme", json={"name": "erfunden-4711"}); check("appearance/theme unbekannt -> 422", r.status_code == 422, f"{r.status_code}")
            r = c.put(f"{B}/hermes-appearance/theme", json={"name": a["active"]}); check("appearance/theme gleiches Theme 200", r.status_code == 200, f"{r.status_code} {r.text[:140]}")
        r = c.put(f"{B}/hermes-appearance/font", json={"font": "https://evil.test/x.css"}); check("appearance/font URL -> 422", r.status_code == 422, f"{r.status_code}")
        # Datenschutz
        r = c.get(f"{B}/hermes-privacy"); p = j(r); check("privacy 200 mit egress und Einwilligung", r.status_code == 200 and isinstance(p.get("egress"), str) and set(p.get("metrics", {})) == {"enabled", "send", "decided", "managed"}, f"{r.status_code} {r.text[:200]}")
        r = c.put(f"{B}/hermes-privacy/metrics", json={"enabled": True, "send": True}); check("privacy/metrics Senden ohne Bestätigung -> 422", r.status_code == 422, f"{r.status_code}")
        # Achievements und Kanban (Host-Ebene)
        r = c.get(f"{H}/_achievements"); ac = j(r); check("achievements 200 mit items", r.status_code == 200 and isinstance(ac.get("items"), list), f"{r.status_code} total={ac.get('total')} {r.text[:120] if r.status_code != 200 else ''}")
        check("achievements: geheime Erfolge ohne Namen", all(i["name"] == "???" for i in ac.get("items", []) if i["state"] == "secret"))
        r = c.post(f"{H}/_achievements/reset", json={"confirm": "falsch"}); check("achievements/reset ohne Wort -> 422", r.status_code == 422, f"{r.status_code}")
        r = c.get(f"{H}/_kanban/diagnostics"); check("kanban/diagnostics 200 mit count", r.status_code == 200 and isinstance(j(r).get("count"), int), f"{r.status_code} {r.text[:140]}")
        r = c.get(f"{H}/_kanban/workers"); check("kanban/workers 200 mit Liste", r.status_code == 200 and isinstance(j(r).get("workers"), list), f"{r.status_code} {r.text[:140]}")
        check("kanban/workers: keine Prozessnummern", "worker_pid" not in r.text and "claim_lock" not in r.text)
        r = c.post(f"{H}/_kanban/dispatch", json={"dry_run": True}); check("kanban/dispatch Vorschau 200 ohne zu starten", r.status_code == 200 and j(r).get("dry_run") is True, f"{r.status_code} {r.text[:160]}")
        r = c.post(f"{H}/_kanban/dispatch", json={"dry_run": False}); check("kanban/dispatch echt ohne Bestätigung -> 422", r.status_code == 422, f"{r.status_code}")
finally:
    if had:
        shutil.copy2(backup, cfg)
    else:
        cfg.unlink(missing_ok=True)
    print("config.yaml der Sandbox zurückgesetzt")

print("\n".join(OUT))
print(f"\n{len(OUT) - len(BAD)}/{len(OUT)} ok")
