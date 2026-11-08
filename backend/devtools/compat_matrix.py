"""Prüft die von der WebUI genutzten Hermes-Pfade gegen mehrere Hermes-Versionen (git-Tags) und nennt je Pfad, wo er fehlt.

    python -m devtools.compat_matrix /pfad/zu/hermes-agent TAG [TAG ...]    # Tags in aufsteigender Reihenfolge

Nur lesend: `git archive` schreibt in ein temporäres Verzeichnis, das Arbeitsverzeichnis von Hermes bleibt unberührt.
Das prüft nur, ob der Pfad existiert, nicht ob Antworten dieselbe Form haben (dafür sind die Vertragstests da).
"""
from __future__ import annotations

import io
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

from .check_upstream import missing

DIRS = ("hermes_cli", "plugins", "gateway")


def snapshot(repo: Path, tag: str, dest: Path) -> None:
    for d in DIRS:  # ältere Stände haben nicht jeden Ordner: einzeln holen, fehlende überspringen
        r = subprocess.run(["git", "-C", str(repo), "archive", tag, "--", d], capture_output=True)
        if r.returncode == 0:
            tarfile.open(fileobj=io.BytesIO(r.stdout)).extractall(dest, filter="data")


def matrix(repo: Path, tags: list[str]) -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    for tag in tags:
        with tempfile.TemporaryDirectory() as tmp:
            snapshot(repo, tag, Path(tmp))
            out[tag] = {f"{group}: {p}" for group, paths in missing(Path(tmp)).items() for p in paths}
    return out


def first_complete(m: dict[str, set[str]], tags: list[str]) -> str | None:
    """Die erste Version, ab der kein Pfad mehr fehlt (und auch in keiner späteren)."""
    ok = None
    for tag in reversed(tags):
        if m[tag]:
            break
        ok = tag
    return ok


def report(m: dict[str, set[str]], tags: list[str]) -> str:
    lines = ["Version | fehlende Pfade", "---|---"] + [f"{t} | {len(m[t])}" for t in tags]
    start = first_complete(m, tags)
    lines.append(f"\nAb {start} sind alle genutzten Pfade vorhanden." if start else "\nIn keiner der Versionen sind alle genutzten Pfade vorhanden.")
    paths = sorted(set().union(*m.values())) if m else []
    for p in paths:
        gone = [t for t in tags if p in m[t]]
        lines.append(f"- {p}: fehlt in {gone[0]} bis {gone[-1]} ({len(gone)} von {len(tags)})" if len(gone) > 1 else f"- {p}: fehlt in {gone[0]}")
    return "\n".join(lines)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    tags = sys.argv[2:]
    print(report(matrix(Path(sys.argv[1]), tags), tags))
