"""Jeder relative Markdown-Link in README*.md und docs/*.md zeigt auf eine existierende Datei.

Jeder in docs/ genannte backend/devtools/...-Pfad existiert.
"""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
LINK = re.compile(r"\[[^\]]*\]\(([^)#\s]+)\)")
TOOL = re.compile(r"(?:backend/)?devtools/[A-Za-z0-9_./-]+\.py")

TARGETS = sorted((ROOT / "docs").glob("*.md"))
SOURCE_FILES = [ROOT / "README.md", ROOT / "README.en.md"] + TARGETS
SKIP_PREFIX = ("http://", "https://", "mailto:", "#")


def _links(path: Path) -> list[str]:
    return [m for m in LINK.findall(path.read_text(encoding="utf-8")) if not m.startswith(SKIP_PREFIX)]


def test_relative_markdown_links_exist():
    missing = [
        f"{p.relative_to(ROOT)} -> {t}"
        for p in SOURCE_FILES
        for t in _links(p)
        if not (p.parent / t).exists() and not (ROOT / t).exists()
    ]
    assert not missing, f"kaputte Links: {missing}"


def test_devtools_paths_mentioned_in_docs_exist():
    # In der Doku steht ueblich "devtools/..." fuer "backend/devtools/...".
    missing = [
        f"{p.relative_to(ROOT)} -> {t}"
        for p in SOURCE_FILES
        for t in sorted(set(TOOL.findall(p.read_text(encoding="utf-8"))))
        if not (ROOT / "backend" / t if t.startswith("devtools/") else ROOT / t).exists()
    ]
    assert not missing, f"fehlende Skripte: {missing}"
