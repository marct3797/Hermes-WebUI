"""Erzeugt THIRD_PARTY_NOTICES.md aus dem Lockfile, den installierten Python-Paketen und den Schrift-Lizenzen.

    python -m devtools.third_party_notices > ../THIRD_PARTY_NOTICES.md      (im Ordner backend, mit installiertem Backend und `npm ci` im Frontend)

Die Schriften (SIL OFL 1.1) stecken als Dateien im gebauten Frontend; die Lizenz verlangt, dass Copyright-Hinweis und Lizenztext mitgeliefert werden.
Kein Rechtsrat: die Angaben stammen aus den Metadaten der Pakete und sind nicht gegen deren Quelltext geprüft.
"""
from __future__ import annotations

import json
import re
import tomllib
from importlib.metadata import distribution, requires
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FONTS = ("inter", "jetbrains-mono")


def npm_runtime() -> list[tuple[str, str, str]]:
    lock = json.loads((ROOT / "frontend/package-lock.json").read_text())["packages"]
    rows = [(p.split("node_modules/")[-1], m.get("version", "?"), m.get("license") or "FEHLT") for p, m in lock.items() if p and not m.get("dev")]
    return sorted(rows)


def python_runtime(component: str) -> list[tuple[str, str, str]]:
    """Laufzeitabhängigkeiten samt Extras (`PyJWT[crypto]`, `uvicorn[standard]`), transitiv."""
    split = lambda req: (re.split(r"[ ;<>=!~\[(]", req.strip())[0], set(re.findall(r"\[([^\]]*)\]", req.split(";")[0]) and re.findall(r"[\w-]+", re.findall(r"\[([^\]]*)\]", req.split(";")[0])[0])))  # noqa: E731
    todo = [split(d) for d in tomllib.loads((ROOT / component / "pyproject.toml").read_text())["project"]["dependencies"]]
    seen: dict[str, tuple[str, str, str]] = {}
    done: set[tuple[str, frozenset[str]]] = set()
    while todo:
        n, extras = todo.pop()
        key = n.lower().replace("_", "-")
        if (key, frozenset(extras)) in done:
            continue
        done.add((key, frozenset(extras)))
        try:
            dist = distribution(n)
        except Exception:  # bedingte Abhängigkeit (Python-Version, Windows), hier nicht installiert
            seen.setdefault(key, (n, "?", "nicht installiert, nicht geprüft"))
            continue
        m = dist.metadata
        lic = m.get("License-Expression") or ", ".join(c.split("::")[-1].strip() for c in m.get_all("Classifier", []) if c.startswith("License")) or (m.get("License") or "FEHLT")[:60]
        seen[key] = (m["Name"], dist.version, lic)
        for req in requires(n) or []:
            wanted = re.findall(r"extra\s*==\s*[\"']([^\"']+)[\"']", req)
            if wanted and not set(wanted) & extras:
                continue
            todo.append(split(req))
    return sorted(seen.values(), key=lambda r: r[0].lower())


def table(rows: list[tuple[str, str, str]]) -> str:
    return "| Paket | Version | Lizenz |\n|---|---|---|\n" + "\n".join(f"| {n} | {v} | {lic} |" for n, v, lic in rows)


def main() -> str:
    out = ["# Lizenzen von Drittanbieter-Software\n",
           "Dieses Projekt steht unter AGPL-3.0-only (siehe `LICENSE`). Es enthält oder benutzt die folgende Software. "
           "Die Angaben stammen aus den Metadaten der Pakete (erzeugt mit `backend/devtools/third_party_notices.py`); kein Rechtsrat.\n",
           "## Schriften im Frontend (SIL Open Font License 1.1)\n"]
    for font in FONTS:
        text = (ROOT / "frontend/node_modules/@fontsource-variable" / font / "LICENSE").read_text().strip()
        out.append(f"### {font}\n\n```\n{text}\n```\n")
    out += ["## Frontend, Laufzeit (npm)\n", "Bauwerkzeuge (Entwicklungsabhängigkeiten, u. a. `lightningcss` unter MPL-2.0) werden nicht ausgeliefert und sind hier nicht aufgeführt.\n", table(npm_runtime()) + "\n"]
    for comp in ("backend", "hostd"):
        out += [f"## {comp} (Python, Laufzeit)\n", table(python_runtime(comp)) + "\n"]
    return "\n".join(out)


if __name__ == "__main__":
    print(main())
