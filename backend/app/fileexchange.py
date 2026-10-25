"""Prüfung für den Datei-Austausch zwischen BFF und Hermes-Dashboard.

Export und Import reichen dem Dashboard nur einen Dateipfad. Das gelingt nur, wenn BFF und Dashboard dasselbe
Dateisystem sehen. Diese Prüfung verhindert, dass ein leeres oder fremdes Ergebnis als Erfolg durchgeht.
"""
from __future__ import annotations

import os
import stat
from pathlib import Path

from fastapi import HTTPException

NOT_SHARED = ("Die Datei liegt nicht im Dateisystem der WebUI. Export und Import gehen nur, wenn WebUI und Hermes "
              "denselben Datenordner sehen. Ausweg: den Befehl auf dem Hermes-Rechner ausführen (siehe docs/file-exchange.md).")
TOO_BIG = "Das Archiv ist zu groß für den Zwischenspeicher der WebUI"
NOT_ARCHIVE = "Das Dashboard hat kein gültiges Archiv (tar.gz oder zip) geliefert"


def read_archive(path: str, limit: int) -> bytes:
    """Liest eine vom Dashboard geschriebene Archivdatei. 502 mit klarer Meldung, wenn sie fehlt, leer, zu groß oder kein Archiv ist."""
    try:
        st = os.lstat(path)
    except OSError:
        raise HTTPException(502, NOT_SHARED) from None
    if not stat.S_ISREG(st.st_mode) or st.st_size == 0:
        raise HTTPException(502, NOT_SHARED)
    if st.st_size > limit:
        raise HTTPException(502, TOO_BIG)
    try:
        data = Path(path).read_bytes()
    except OSError:
        raise HTTPException(502, NOT_SHARED) from None
    if not (data[:2] == b"\x1f\x8b" or data[:2] == b"PK"):
        raise HTTPException(502, NOT_ARCHIVE)
    return data
