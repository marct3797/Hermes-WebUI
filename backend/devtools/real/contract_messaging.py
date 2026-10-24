"""Messaging-Routen gegen ein ECHTES Hermes-Dashboard (Sandbox-HOME, nie die echte Installation). Aufbau wie contract_config.py.

Bewusst NICHT ausgefuehrt: Gateway starten/stoppen (wuerde mit gesetztem Token einen echten Prozess und Verbindungsversuch starten) und das
Telegram-Onboarding (ruft einen externen Dienst von Nous auf). Geschrieben wird ein erfundenes Token; es wird am Ende wieder entfernt.
"""
import json, sys, tempfile, urllib.request
from pathlib import Path
from fastapi.testclient import TestClient
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from app.config import Settings
from app.main import create_app

PORT, TOKEN = 9199, "sandbox-token-0123456789"
FAKE = "123456789:AAFakeTokenNurFuerDenSandboxTest_0123456"
work = Path(tempfile.mkdtemp())
(work / "hosts.json").write_text(json.dumps({"hosts": [{"id": "lokal", "kind": "local", "runtimes": [
    {"id": "hermes", "base_url": "http://127.0.0.1:1", "api_key": "x" * 16, "multiplex": False,
     "dashboard": {"base_url": f"http://127.0.0.1:{PORT}", "token": TOKEN}, "agents": ["default"]}]}]}))
s = Settings(env="dev", hosts_file=work / "hosts.json", audit_file=work / "audit.log", rooms_db=work / "rooms.db", soul_dir=work / "soul", runs_per_minute=1000)


def dash(method, path, body=None):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"X-Hermes-Session-Token": TOKEN, "Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=20).read() or b"null")


assert "sandbox" in dash("GET", "/api/profiles")["profiles"][0]["path"], "ABBRUCH: Profilpfad liegt nicht in der Sandbox"
print("Sandbox-Pfad geprueft")
with TestClient(create_app(s)) as c:
    c.headers["X-Requested-With"] = "hermes-webui"
    B = "/bff/h/lokal/hermes/default"
    r = c.get(f"{B}/messaging"); pl = {p["id"]: p for p in r.json()["platforms"]}
    print("Plattformen:", r.status_code, len(pl), "| Zustaende:", sorted({p["state"] for p in pl.values()}), "| ohne Pflichtfelder:", sum(1 for p in pl.values() if not p["env_vars"]))
    print("Klartextwerte nur bei Nicht-Geheimnissen:", sorted({v["key"] for p in pl.values() for v in p["env_vars"] if "value" in v and v["is_password"]}) == [])
    print("keine Server-Pfade in der Antwort:", "/home/" not in r.text and "env_path" not in r.text)
    tg = pl["telegram"]; print("telegram Variablen:", [(v["key"], v["is_password"], v["required"]) for v in tg["env_vars"]])
    w = c.put(f"{B}/messaging/telegram", json={"enabled": True, "env": {"TELEGRAM_BOT_TOKEN": FAKE, "TELEGRAM_ALLOWED_USERS": "123456"}})
    print("Konfigurieren:", w.status_code, w.text[:200], "| Token in Antwort:", FAKE in w.text)
    after = {p["id"]: p for p in c.get(f"{B}/messaging").json()["platforms"]}["telegram"]
    print("danach:", after["enabled"], after["configured"], after["state"], [(v["key"], v["is_set"], v.get("value")) for v in after["env_vars"]], "| Token in Lese-Antwort:", FAKE in c.get(f"{B}/messaging").text)
    t = c.post(f"{B}/messaging/telegram/test"); print("Pruefen:", t.status_code, t.json())
    bad = c.put(f"{B}/messaging/telegram", json={"env": {"TELEGRAM_BOT_TOKEN": "kein-token"}}); print("Token mit falschem Aufbau:", bad.status_code, bad.text[:160])
    other = c.put(f"{B}/messaging/telegram", json={"env": {"DISCORD_BOT_TOKEN": "x"}}); print("Variable einer anderen Plattform:", other.status_code)
    g = c.get(f"{B}/gateway"); print("Gateway:", g.status_code, g.json())
    a = c.get(f"{B}/gateway/actions/gateway-start"); print("Aktion (nichts gelaufen):", a.status_code, a.json())
    off = c.put(f"{B}/messaging/telegram", json={"enabled": False, "clear_env": ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS"]})
    print("Aufraeumen:", off.status_code, off.text[:120])
    clean = {p["id"]: p for p in c.get(f"{B}/messaging").json()["platforms"]}["telegram"]
    print("sauber:", not clean["enabled"] and not any(v["is_set"] for v in clean["env_vars"]))
print("Audit:", [l.split('"action":"')[1].split('"')[0] for l in (work / "audit.log").read_text().splitlines()], "| Token im Audit:", FAKE in (work / "audit.log").read_text())
