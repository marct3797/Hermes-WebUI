"""Anbieter-Übersicht aus dem Dashboard: wer ist eingerichtet, womit (Key, Anmeldung) und was wurde darüber verbraucht.

Quellen sind `/api/env` (Keys je Anbieter, geschwärzt), `/api/providers/oauth` (Anmeldestatus) und `/api/analytics/models`
(Tokens und Kosten je Modell). Die Funktionen sind rein und tolerant: fehlt ein Feld, bleibt es leer statt zu scheitern.
Key-Werte kommen nie im Klartext an, das Dashboard liefert nur `redacted_value`.
"""
from __future__ import annotations

from typing import Any


def _rows(value: Any) -> list[dict[str, Any]]:
    return [r for r in value if isinstance(r, dict)] if isinstance(value, list) else []


def provider_keys(env: Any) -> dict[str, dict[str, Any]]:
    """Alle Env-Variablen, die zu einem Anbieter gehören (`var` → Zeile). Nachrichtenkanäle und Werkzeug-Keys fallen heraus."""
    if not isinstance(env, dict):
        return {}
    return {
        var: row for var, row in env.items()
        if isinstance(row, dict) and not row.get("channel_managed") and (row.get("provider") or row.get("category") == "provider")
    }


def _num(v: Any) -> float:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else 0.0


def build_overview(env: Any, oauth: Any, analytics: Any, days: int) -> dict[str, Any]:
    groups: dict[str, dict[str, Any]] = {}

    def group(slug: str, label: str | None = None) -> dict[str, Any]:
        g = groups.setdefault(slug, {"id": slug, "label": label or slug, "keys": [], "oauth": None, "usage": None})
        if label and g["label"] == slug:
            g["label"] = label
        return g

    for var, row in provider_keys(env).items():
        slug = str(row.get("provider") or var)
        group(slug, row.get("provider_label") or None)["keys"].append({
            "var": var, "set": bool(row.get("is_set")), "redacted": row.get("redacted_value") if row.get("is_set") else None,
            "description": str(row.get("description") or ""), "url": row.get("url") or None,
            "secret": bool(row.get("is_password", True)), "advanced": bool(row.get("advanced")),
        })

    for p in _rows(oauth.get("providers") if isinstance(oauth, dict) else None):
        slug = str(p.get("id") or "")
        if not slug:
            continue
        status = p.get("status") if isinstance(p.get("status"), dict) else {}
        group(slug, p.get("name") or None)["oauth"] = {
            "logged_in": bool(status.get("logged_in")), "flow": p.get("flow"), "source": status.get("source_label") or status.get("source"),
            "expires_at": status.get("expires_at"), "cli_command": p.get("cli_command"), "docs_url": p.get("docs_url"),
        }

    for m in _rows(analytics.get("models") if isinstance(analytics, dict) else None):
        slug = str(m.get("provider") or "")
        if not slug:
            continue
        u = group(slug)["usage"] or {"sessions": 0, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0, "last_used_at": None, "models": []}
        u["sessions"] += int(_num(m.get("sessions")))
        u["input_tokens"] += int(_num(m.get("input_tokens")))
        u["output_tokens"] += int(_num(m.get("output_tokens")))
        u["cost_usd"] += _num(m.get("actual_cost")) or _num(m.get("estimated_cost"))
        last = m.get("last_used_at")
        if isinstance(last, (int, float)) and (u["last_used_at"] is None or last > u["last_used_at"]):
            u["last_used_at"] = last
        u["models"].append(str(m.get("model") or "?"))
        groups[slug]["usage"] = u

    out = []
    for g in groups.values():
        g["configured"] = any(k["set"] for k in g["keys"]) or bool(g["oauth"] and g["oauth"]["logged_in"])
        g["used"] = bool(g["usage"] and g["usage"]["sessions"])
        out.append(g)
    # Eingerichtete zuerst, dann solche, die nur genutzt wurden, dann der Rest; innerhalb davon nach Verbrauch und Name.
    out.sort(key=lambda g: (not g["configured"], not g["used"], -((g["usage"] or {}).get("input_tokens", 0) + (g["usage"] or {}).get("output_tokens", 0)), g["label"].lower()))
    return {"providers": out, "period_days": days}
