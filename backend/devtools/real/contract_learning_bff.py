"""Lerngraph Ende-zu-Ende: das ECHTE BFF gegen das ECHTE Sandbox-Dashboard (Port 9199, eigenes HOME; nie die echte Installation).

Der Graph einer frischen Installation ist leer (nur Skills mit Lernsignal und Gedächtnis-Einträge sind Knoten). Das Skript legt deshalb in der Sandbox
einen Skill (von „agent“ angelegt) und zwei Gedächtnis-Einträge an, liest, bearbeitet und löscht sie über das BFF und räumt alles wieder auf.
Sandbox-Pfad wird über /api/profiles geprüft und muss „sandbox“ enthalten.
"""
import json, shutil, sys, tempfile, urllib.request
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
OUT, BAD = [], []


def check(label, cond, extra=""):
    line = f"{'ok' if cond else 'FEHLT'}: {label} {extra}".rstrip()
    OUT.append(line)
    if not cond:
        BAD.append(line)


def dash(method, path):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", method=method, headers={"X-Hermes-Session-Token": TOKEN})
    return json.loads(urllib.request.urlopen(req, timeout=20).read() or b"null")


home = Path(dash("GET", "/api/profiles")["profiles"][0]["path"])
assert "sandbox" in str(home), f"ABBRUCH: Profilpfad {home} liegt nicht in der Sandbox"
SKILL, MEM = home / "skills" / "e2e-learn", home / "memories" / "MEMORY.md"
USAGE = home / "skills" / ".usage.json"
saved = {p: (p.read_bytes() if p.exists() else None) for p in (MEM, USAGE)}
try:
    SKILL.mkdir(parents=True, exist_ok=True)
    (SKILL / "SKILL.md").write_text("---\nname: e2e-learn\ndescription: Sandbox-Skill für den Lerngraph\n---\n# E2E Learn\nOriginaltext\n")
    USAGE.write_text(json.dumps({**json.loads(saved[USAGE] or b"{}"), "e2e-learn": {"created_by": "agent", "use_count": 2, "state": "active"}}))
    MEM.parent.mkdir(parents=True, exist_ok=True)
    MEM.write_text("E2E Erinnerung eins\n§\nE2E Erinnerung zwei")
    with TestClient(create_app(s)) as c:
        c.headers["X-Requested-With"] = "hermes-webui"
        B = "/bff/h/lokal/hermes/default/hermes-learning"
        r = c.get(B); g = r.json() if r.status_code == 200 else {}
        ids = [n["id"] for n in g.get("nodes", [])]
        check("graph 200 mit Skill und Erinnerungen als Knoten", r.status_code == 200 and "e2e-learn" in ids and sum(i.startswith("memory:") for i in ids) == 2, f"{r.status_code} ids={ids}")
        check("graph: keine Serverpfade", "/home/" not in r.text and '"path"' not in r.text)
        mems = [i for i in ids if i.startswith("memory:")]
        check("graph: Kanten verweisen nur auf vorhandene Knoten", all(e["source"] in ids and e["target"] in ids for e in g.get("edges", [])), f"edges={len(g.get('edges', []))}")
        # Skill lesen, bearbeiten, zurücklesen
        r = c.get(f"{B}/node", params={"id": "e2e-learn"}); check("skill lesbar, Inhalt ist die SKILL.md", r.status_code == 200 and "Originaltext" in r.json().get("content", ""), f"{r.status_code} {r.text[:140]}")
        new = "---\nname: e2e-learn\ndescription: Sandbox-Skill für den Lerngraph\n---\n# E2E Learn\nGeändert\n"
        r = c.put(f"{B}/node", json={"id": "e2e-learn", "content": new}); check("skill bearbeiten 200 (Rücklesen bestätigt)", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        check("skill auf der Platte geändert", "Geändert" in (SKILL / "SKILL.md").read_text())
        r = c.put(f"{B}/node", json={"id": "e2e-learn", "content": "---\nkaputt"}); check("skill mit ungültigem Frontmatter: Hermes lehnt ab, Text kommt durch, nichts geschrieben", r.status_code in (422, 502) and "Geändert" in (SKILL / "SKILL.md").read_text(), f"{r.status_code} {r.text[:160]}")
        # Erinnerung lesen, bearbeiten
        if mems:
            r = c.get(f"{B}/node", params={"id": mems[0]}); check("erinnerung lesbar (ID mit Doppelpunkten)", r.status_code == 200 and "eins" in r.json().get("content", ""), f"{r.status_code} {r.text[:140]} id={mems[0]}")
            r = c.put(f"{B}/node", json={"id": mems[0], "content": "E2E Erinnerung geändert"}); check("erinnerung bearbeiten 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
            check("erinnerung auf der Platte geändert", "geändert" in MEM.read_text())
            ids2 = [n["id"] for n in c.get(B).json()["nodes"] if n["id"].startswith("memory:")]
            # nach dem Bearbeiten ändert sich der Fingerabdruck der ID: die alte ID muss ins Leere laufen, die Seite lädt den Graphen neu
            check("erinnerung hat nach dem Bearbeiten eine neue ID", len(ids2) == 2, f"{ids2}")
            victim = next((i for i in ids2 if i != mems[0]), ids2[0])
            victim_text = c.get(f"{B}/node", params={"id": victim}).json().get("content", "")
            r = c.request("DELETE", f"{B}/node", params={"id": victim, "confirm": "falsch"}); check("erinnerung löschen ohne ID -> 422", r.status_code == 422, f"{r.status_code}")
            r = c.request("DELETE", f"{B}/node", params={"id": victim, "confirm": victim}); check("erinnerung löschen mit ID 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
            left = MEM.read_text()
            check("genau die gewählte Erinnerung ist weg, die andere bleibt", bool(victim_text) and victim_text not in left and left.strip() != "" and "§" not in left, left[:80])
        # Skill löschen = archivieren
        r = c.request("DELETE", f"{B}/node", params={"id": "e2e-learn", "confirm": "e2e-learn"}); check("skill löschen 200 (Hermes archiviert)", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        check("skill-Ordner archiviert statt gelöscht", not SKILL.exists() and any((home / "skills" / ".archive").glob("e2e-learn*")), str(list((home / "skills").glob(".archive/*"))[:3]))
        r = c.get(f"{B}/node", params={"id": "e2e-learn"}); check("gelöschter Skill -> 404", r.status_code == 404, f"{r.status_code}")
finally:
    shutil.rmtree(SKILL, ignore_errors=True)
    for a in (home / "skills" / ".archive").glob("e2e-learn*"):
        shutil.rmtree(a, ignore_errors=True)
    for p, b in saved.items():
        if b is None:
            p.unlink(missing_ok=True)
        else:
            p.write_bytes(b)
    print("Sandbox-Dateien zurückgesetzt")

print("\n".join(OUT))
print(f"\n{len(OUT) - len(BAD)}/{len(OUT)} ok")
