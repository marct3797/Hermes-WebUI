"""Audit-Log: eine JSON-Zeile je sicherheitsrelevantem Vorgang.

Geloggt wird, wer was wann an welchem Ziel getan hat, nie der Inhalt: keine Nachrichtentexte, keine
Keys, keine Tokens. Schreibfehler stören den Betrieb nicht, landen aber im Anwendungslog.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any

log = logging.getLogger("hermes_webui.audit")
_MAX_STR = 200


class AuditLog:
    def __init__(self, path: Path | None):
        self._path = path
        self._lock = threading.Lock()

    def record(
        self, action: str, *, user: str | None = None, ip: str | None = None, target: str | None = None,
        outcome: str = "ok", **detail: Any,
    ) -> None:
        entry = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "action": action, "outcome": outcome, "user": user, "ip": ip, "target": target,
            "detail": {k: _clip(v) for k, v in detail.items()},
        }
        line = json.dumps(entry, ensure_ascii=False, separators=(",", ":"))
        log.info("audit %s", line)
        if self._path is None:
            return
        try:
            with self._lock:
                # Neu angelegte Datei nur für den Dienstnutzer lesbar.
                fd = os.open(self._path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
                with os.fdopen(fd, "a", encoding="utf-8") as f:
                    f.write(line + "\n")
        except OSError:
            log.exception("Audit-Log nicht schreibbar: %s", self._path)


def _clip(v: Any) -> Any:
    if isinstance(v, str):
        return v[:_MAX_STR]
    if isinstance(v, (int, float, bool)) or v is None:
        return v
    return str(v)[:_MAX_STR]
