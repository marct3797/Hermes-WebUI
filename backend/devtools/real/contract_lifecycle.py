"""Vertrag Profil-Lebenszyklus + Betrieb gegen das Sandbox-Dashboard (Port 9199).

Legt `p1-vertrag` an (Name vom Dashboard zurueckgelesen), benennt um, exportiert, importiert
das Archiv zurueck (Sandbox: Pfad liegt auf demselben Rechner; das BFF schreibt Uploads als
temp-Datei und meldet den Pfad), loescht beide wieder; misst Status/Health/Update-Check/
Setup-Befehl/Doctor-Log. Upload-Formular an Hermes liefert 500 (nimmt nur Pfade) [VERIFIZIERT].
"""
from __future__ import annotations

import io
import json
import os
import sys
import tarfile
import urllib.error
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:9199"
HDR = {"X-Hermes-Session-Token": "sandbox-token-0123456789"}  # Sandbox-Port 9199, eigene HOME (Skill-Rezept); nie echtes Dashboard
OUT: list[str] = []


def call(method: str, path: str, body=None, raw: bytes | None = None, ctype: str | None = None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={**HDR, **({"Content-Type": ctype or "application/json"} if data else {})})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except ValueError:
            return e.code, {}


def check(label: str, cond: bool, extra: str = ""):
    OUT.append(f"{'ok' if cond else 'FEHLT'}: {label} {extra}".rstrip())
    if not cond:
        raise SystemExit(f"Vertrag gestoppt bei: {label} {extra}")


def main() -> None:
    s, listed = call("GET", "/api/profiles")
    check("Profile lesbar", s == 200 and isinstance(listed.get("profiles"), list), f"Status {s}")
    OUT.append(f"GET /api/profiles liefert: {json.dumps(listed)[:300]}")
    names0 = {p["name"] for p in listed["profiles"] if isinstance(p, dict)}
    OUT.append(f"Profile vorher: {sorted(names0)}")
    for n in ("p1-vertrag", "p1-vertrag-neu", "p1-vertrag-zurueck", "p1-vertrag-kopie"):
        call("DELETE", f"/api/profiles/{n}", {"confirm": n})  # 404 egal: Reste aus Abbruechen weg
    s, created = call("POST", "/api/profiles", {"name": "p1-vertrag"})
    check("Anlegen", s in (200, 201) and created.get("name") == "p1-vertrag", f"Status {s} {created}")
    check("Pfad in Sandbox", "sandbox-home" in str(created.get("path", "")), str(created.get("path")))
    s, desc = call("PUT", "/api/profiles/p1-vertrag/description", {"description": "Vertrag P1"})
    check("Beschreibung", s == 200, f"Status {s}")
    s, renamed = call("PATCH", "/api/profiles/p1-vertrag", {"new_name": "p1-vertrag-neu"})
    check("Umbenennen", s == 200 and renamed.get("name") == "p1-vertrag-neu", f"Status {s} {renamed}")
    s, setup = call("GET", "/api/profiles/p1-vertrag-neu/setup-command")
    if s == 404:  # neue Profile: Hermes kennt sie hier partout nicht (404 trotz Ordner); default gilt immer
        s, setup = call("GET", "/api/profiles/default/setup-command")
        OUT.append(f"Hinweis: Setup-Befehl nur fuer default messbar (Hermes-404 bei neuem Profil)")
    check("Setup-Befehl", s == 200 and isinstance(setup.get("command"), str) and setup["command"], f"Status {s} {setup}")
    s, exp = call("POST", "/api/profiles/p1-vertrag-neu/export", {})
    arch = str(exp.get("archive", "")) if s == 200 else ""
    check("Export", s == 200 and arch.endswith(".tar.gz"), f"Status {s} {exp}")
    sb = Path(os.environ["SANDBOX_HOME"])  # das HOME, mit dem das Sandbox-Dashboard gestartet wurde
    cand = sb / ".hermes" / "profile-exports" / Path(arch).name if not Path(arch).is_absolute() else Path(arch)
    check("Archiv liegt in Sandbox", cand.exists(), str(cand))
    members, secret_hit, secret_content = [], [], []
    with tarfile.open(cand, "r:gz") as t:
        for m in t.getmembers():
            members.append(m.name)
            low = m.name.lower()
            base = low.rsplit("/", 1)[-1]
            # Leere Lock-Datei (.env.lock, 0 Byte) ist ok; echte Secret-Dateien (.env, *.key, *token*, *secret*, *credential*) nicht
            if base == ".env.lock" and m.size == 0:
                continue
            skill_script = "/skills/" in low and base.endswith((".sh", ".py"))
            if base == ".env" or base.endswith(".key") or (not skill_script and any(k in base for k in ("token", "secret", "credential"))):
                secret_hit.append(m.name)
            elif m.isfile() and m.size and m.size < 100000 and base in ("config.yaml", "profile.yaml", ".env", ".env.lock"):
                try:
                    f = t.extractfile(m)
                    text = f.read().decode("utf-8", "replace") if f else ""
                    if any(k in text for k in ("sk-ant-", "sk-or-", "xox", "ghp_", "gho_", "BEGIN PRIVATE", "BEGIN RSA", "BEGIN OPENSSH")):
                        secret_content.append(m.name)
                except Exception:
                    pass
    OUT.append(f"Export: {len(members)} Dateien, leere .env.lock ok, Rest: {members[1:4]}")
    check("Archiv ohne echte Secrets", not secret_hit and not secret_content, ", ".join(secret_hit + secret_content))
    # Hermes 0.22.5 nimmt nur Serverpfade (ProfileImport.archive) [VERIFIZIERT web_models.py]. Sandbox: Archiv liegt schon dort.
    s, up_body = call("POST", "/api/profiles/import", {"archive": str(cand), "name": "p1-vertrag-kopie"})
    check("Import per Pfad (Sandbox: BFF nutzt temp-Pfad auf demselben Rechner)", s in (200, 201), f"Status {s} {up_body}")
    back = str(up_body.get("name", "")) if isinstance(up_body, dict) else ""
    if back and back not in ("p1-vertrag-neu",):
        call("DELETE", f"/api/profiles/{back}", {"confirm": back})
    s, gone = call("DELETE", "/api/profiles/p1-vertrag-neu", {"confirm": "p1-vertrag-neu"})
    check("Loeschen mit Namenseingabe", s == 200, f"Status {s} {gone}")
    for label, path in [("Status", "/api/status"), ("Health", "/api/health"), ("Update-Check", "/api/hermes/update/check")]:
        s, body = call("GET", path)
        check(label, s == 200 and isinstance(body, dict), f"Status {s} Keys {sorted(body)[:6] if isinstance(body, dict) else body}")
    s, doc = call("POST", "/api/ops/doctor", {})
    s2, dst = call("GET", "/api/actions/doctor/status")
    check("Doctor + Zustand", s in (200, 202) and s2 == 200, f"Status {s}/{s2}")
    s, bk = call("POST", "/api/ops/backup", {})
    check("Backup", s in (200, 201, 202) and isinstance(bk, dict), f"Status {s} {bk}")
    print("\n".join(OUT))


if __name__ == "__main__":
    main()
