"""Werkzeug-Routen gegen ein ECHTES Hermes-Dashboard (Sandbox-HOME, nie die echte Installation). Aufbau wie contract_config.py.

Geschrieben wird nur in die Sandbox; der Testschlüssel wird am Ende per Dashboard-API wieder entfernt.
"""
import json, sys, tempfile, urllib.request
from pathlib import Path
from fastapi.testclient import TestClient
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from app.config import Settings
from app.main import create_app

PORT, TOKEN = 9199, "sandbox-token-0123456789"
SECRET = "fc-test-nur-sandbox-4711"
work = Path(tempfile.mkdtemp())
(work / "hosts.json").write_text(json.dumps({"hosts": [{"id": "lokal", "kind": "local", "runtimes": [
    {"id": "hermes", "base_url": "http://127.0.0.1:1", "api_key": "x" * 16, "multiplex": False,
     "dashboard": {"base_url": f"http://127.0.0.1:{PORT}", "token": TOKEN}, "agents": ["default"]}]}]}))
s = Settings(env="dev", hosts_file=work / "hosts.json", audit_file=work / "audit.log", rooms_db=work / "rooms.db", soul_dir=work / "soul", runs_per_minute=1000)


def dash(method, path, body=None):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"X-Hermes-Session-Token": TOKEN, "Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=20).read() or b"null")


home = dash("GET", "/api/profiles")["profiles"][0]["path"]
assert "sandbox" in home, f"ABBRUCH: Profilpfad {home} liegt nicht in der Sandbox"
print("Sandbox-Pfad geprueft")

with TestClient(create_app(s)) as c:
    c.headers["X-Requested-With"] = "hermes-webui"
    T = "/bff/h/lokal/hermes/default/tools"
    lst = c.get(T); sets = {t["name"]: t for t in lst.json()["toolsets"]}
    print("Liste:", lst.status_code, len(sets), "Gruppen | aktiv:", sum(1 for t in sets.values() if t["enabled"]), "| ohne Keys:", [n for n, t in sets.items() if not t["configured"]])
    web = c.get(f"{T}/web"); wj = web.json()
    print("web:", web.status_code, [(p["name"], p["status"], [v["key"] for v in p["env_vars"]]) for p in wj["providers"]][:4], "| aktiv:", wj["active_provider"])
    cu = c.get(f"{T}/computer_use").json()
    print("computer_use Anbieter mit post_setup:", [(p["name"], p["post_setup"], p["status"]) for p in cu["providers"] if p.get("post_setup")])
    # Hermes installiert beim Einschalten nur, wenn das Dashboard den Anbieter als "needs_setup" meldet. Ist cua-driver da ("ready"), braucht es keine Zustimmung.
    state = {t["name"]: t["enabled"] for t in c.get(T).json()["toolsets"]}["computer_use"]
    r = c.put(f"{T}/computer_use", json={"enabled": not state})
    print("computer_use umschalten (Programm vorhanden?):", r.status_code, r.text[:110])
    c.put(f"{T}/computer_use", json={"enabled": state, "accept_install": False})
    print("computer_use zurueck:", {t["name"]: t["enabled"] for t in c.get(T).json()["toolsets"]}["computer_use"] == state)

    # Schluessel: Brave (kostenlos) in die Sandbox schreiben, lesen, wieder entfernen
    brave = next(p for p in wj["providers"] if p["name"].startswith("Brave"))
    key = brave["env_vars"][0]["key"]
    w = c.put(f"{T}/web/env", json={"env": {key: SECRET}})
    print("Key schreiben:", w.status_code, w.json(), "| Wert in Antwort:", SECRET in w.text)
    after = c.get(f"{T}/web")
    print("Key gelesen:", [v for p in after.json()["providers"] for v in p["env_vars"] if v["key"] == key][0]["is_set"], "| Wert in Lese-Antwort:", SECRET in after.text)
    bad = c.put(f"{T}/web/env", json={"env": {"PATH": "/tmp"}}); print("PATH ueber Gruppe:", bad.status_code, bad.text[:90])
    pv = c.put(f"{T}/web/provider", json={"provider": brave["name"]}); print("Anbieter:", pv.status_code, pv.text[:100])
    print("aktiver Anbieter:", c.get(f"{T}/web").json()["active_provider"])
    tg = c.put(f"{T}/web", json={"enabled": not sets["web"]["enabled"]}); print("Umschalten web:", tg.status_code, tg.text[:120])
    # Web-Anbieter haben post_setup (ddgs, xai_grok) und stehen auf needs_setup/needs_auth; Hermes installiert dafuer beim Einschalten nichts (Quelltext: _POST_SETUP_INSTALLED kennt nur cua_driver).
    back = c.put(f"{T}/web", json={"enabled": sets["web"]["enabled"], "accept_install": True}); print("web zurueck schalten:", back.status_code, back.text[:100])
    print("web zurueck:", {t["name"]: t["enabled"] for t in c.get(T).json()["toolsets"]}["web"] == sets["web"]["enabled"])

    # Bilder: Katalog nach Anbieterwahl
    fal = next((p for p in c.get(f"{T}/image_gen").json()["providers"] if p["name"] == "FAL.ai"), None)
    if fal:
        c.put(f"{T}/image_gen/provider", json={"provider": "FAL.ai"})
        m = c.get(f"{T}/image_gen/models").json()
        print("image_gen Modelle:", m["has_models"], m.get("provider"), len(m["models"]), "| aktuell:", m.get("current"))
        if m["models"] and len(m["models"]) > 1:
            other = next(x["id"] for x in m["models"] if x["id"] != m["current"])
            mr = c.put(f"{T}/image_gen/model", json={"model": other}); print("Modell setzen:", mr.status_code, mr.text[:90])
            c.put(f"{T}/image_gen/model", json={"model": m["current"]})
    tb = c.get("/bff/h/lokal/hermes/default/terminal-backends"); print("Terminal-Backends:", tb.status_code, tb.json()["active"], [(b["name"], b["status"]) for b in tb.json()["backends"]])
    for m_, p_ in (("PUT", "/bff/h/lokal/hermes/default/terminal-backend"), ("POST", f"{T}/web/post-setup")):
        print("nicht vorhanden:", m_, p_.split("default")[1], c.request(m_, p_, json={"backend": "local", "key": "x"}).status_code)

# Aufraeumen (Sandbox): Testschluessel entfernen
try:
    dash("DELETE", "/api/env", {"key": key})
    print("Aufgeraeumt:", key not in dash("GET", "/api/env") or not dash("GET", "/api/env")[key]["is_set"])
except Exception as e:
    print("Aufraeumen:", e)
print("Audit:", [l.split('"action"')[1][:60] for l in (work / "audit.log").read_text().splitlines()][:8], "| Wert im Audit:", SECRET in (work / "audit.log").read_text())
