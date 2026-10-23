"""Restkontingente: normalisiert die Antwort des Dashboard-Plugins `ai-usage-tracker` zu einer stabilen Form.

Das Plugin fragt die Anbieter selbst ab; das BFF baut das nicht nach. Hier steht nur, was daraus für die Anzeige wird:
Zustand je Anbieter, Rest in Prozent, Sekunden bis zum Reset und die Erkennung abgelaufener Zugänge.
"""
from __future__ import annotations

import re
import time
from datetime import date, datetime, timezone
from typing import Any

LOW_PERCENT = 10.0
PLUGIN_MISSING = "Plugin ai-usage-tracker auf diesem Host nicht installiert"
# Gründe des Plugins, die auf einen abgelaufenen oder fehlenden Zugang hindeuten (Kleinschreibung, Teilstring).
AUTH_WORDS = ("401", "403", "unauthorized", "unauthorised", "forbidden", "expired", "invalid key", "invalid api key", "invalid token",
              "not signed in", "not logged in", "sign in", "re-authenticate", "reauth", "token revoked")
# Schlüssel, die nie nach außen gehen, auch wenn das Plugin sie einmal mitliefert.
SECRET_KEY = re.compile(r"token|secret|password|passwd|email|org_?id|api_?key|authorization|cookie|(^|_)key$", re.I)


def strip_secrets(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: strip_secrets(v) for k, v in value.items() if not SECRET_KEY.search(str(k))}
    if isinstance(value, list):
        return [strip_secrets(v) for v in value]
    return value


def is_auth_failure(reason: str | None) -> bool:
    low = (reason or "").lower()
    return any(w in low for w in AUTH_WORDS)


def reset_in_s(reset_at: Any, now: float | None = None) -> int | None:
    """Sekunden bis zum Reset (nie negativ). Ohne Zeitzone gilt UTC, ein reines Datum (\"2026-11-01\") meint 00:00 UTC."""
    if not isinstance(reset_at, str) or not reset_at.strip():
        return None
    text = reset_at.strip()
    try:
        dt = datetime.fromisoformat(text) if "T" in text or " " in text else datetime.combine(date.fromisoformat(text), datetime.min.time())
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return max(0, int(dt.timestamp() - (time.time() if now is None else now)))


def _percent(v: Any) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _window(w: dict[str, Any], now: float | None) -> dict[str, Any]:
    used, rest = _percent(w.get("used_percent")), _percent(w.get("remaining_percent"))
    if rest is None and used is not None:
        rest = max(0.0, 100.0 - used)
    if used is None and rest is not None:
        used = 100.0 - rest
    reset = w.get("reset_at") if isinstance(w.get("reset_at"), str) else None
    return {"label": str(w.get("label") or ""), "used_percent": used, "remaining_percent": rest, "reset_at": reset, "reset_in_s": reset_in_s(reset, now),
            "detail": w.get("detail") if isinstance(w.get("detail"), str) else None}


def _provider(p: dict[str, Any], now: float | None) -> dict[str, Any]:
    q = p.get("quota") if isinstance(p.get("quota"), dict) else {}
    windows = [_window(w, now) for w in q.get("windows") or [] if isinstance(w, dict)]
    rests = [w["remaining_percent"] for w in windows if w["remaining_percent"] is not None]
    worst = min(rests) if rests else None
    reason = q.get("unavailable_reason") if isinstance(q.get("unavailable_reason"), str) else None
    in_use = bool(p.get("configured") or p.get("active"))  # ein unbekannter Anbieter ohne Zugang hat keinen "abgelaufenen" Zugang
    if worst is not None:
        state = "exhausted" if worst <= 0 else "low" if worst < LOW_PERCENT else "ok"
    elif is_auth_failure(reason) and in_use:
        state = "auth_failed"
    else:
        state, reason = "unavailable", reason or ("Das Plugin liefert keine Fenster" if p.get("quota_capable") else "Dieser Anbieter hat keine Abfrage-Schnittstelle")
    return {"id": str(p.get("id") or ""), "label": str(p.get("label") or p.get("id") or ""), "configured": bool(p.get("configured")), "active": bool(p.get("active")),
            "quota_capable": bool(p.get("quota_capable")), "plan": q.get("plan") if isinstance(q.get("plan"), str) else None, "state": state,
            "worst_remaining_percent": worst, "windows": windows, "reason": reason if state in ("unavailable", "auth_failed") else None}


def normalize(body: Any, now: float | None = None) -> dict[str, Any]:
    """Antwort von `/api/plugins/ai-usage-tracker/usage` -> {state, reason, generated_at, cached, providers}."""
    now_s = time.time() if now is None else now
    stamp = datetime.fromtimestamp(now_s, timezone.utc).isoformat()
    if not isinstance(body, dict) or not isinstance(body.get("providers"), list):
        return {"state": "error", "reason": "Das Plugin liefert keine Anbieterliste", "generated_at": stamp, "cached": False, "providers": []}
    body = strip_secrets(body)
    return {"state": "ok", "reason": None, "generated_at": body.get("generated_at") if isinstance(body.get("generated_at"), str) else stamp,
            "cached": bool(body.get("cached")), "providers": [_provider(p, now_s) for p in body["providers"] if isinstance(p, dict)]}


def failure(state: str, reason: str) -> dict[str, Any]:
    return {"state": state, "reason": reason, "generated_at": datetime.now(timezone.utc).isoformat(), "cached": False, "providers": []}


def summary_items(host: str, runtime: str, profile: str, quota: dict[str, Any]) -> list[dict[str, Any]]:
    """Je Anbieter das schlechteste Fenster (für das Cockpit); Anbieter ohne Fenster nur bei abgelaufenem Zugang."""
    out = []
    for p in quota["providers"]:
        if p["state"] == "auth_failed":
            out.append({"host": host, "runtime": runtime, "profile": profile, "provider": p["id"], "label": p["label"], "state": "auth_failed",
                        "remaining_percent": None, "window": None, "reset_in_s": None, "reason": p["reason"]})
        elif p["windows"]:
            w = min((w for w in p["windows"] if w["remaining_percent"] is not None), key=lambda w: w["remaining_percent"], default=None)
            if w:
                out.append({"host": host, "runtime": runtime, "profile": profile, "provider": p["id"], "label": p["label"], "state": p["state"],
                            "remaining_percent": w["remaining_percent"], "window": w["label"], "reset_in_s": w["reset_in_s"], "reason": None})
    return out


class RefreshGate:
    """Ein erzwungenes Neuladen je Schlüssel alle `seconds` Sekunden; sonst gilt der Cache des Plugins (60 s)."""

    def __init__(self, seconds: float = 15.0):
        self.seconds, self._last = seconds, {}

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        if now - self._last.get(key, -1e9) < self.seconds:
            return False
        self._last[key] = now
        return True
