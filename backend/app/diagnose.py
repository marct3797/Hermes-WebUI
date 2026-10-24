"""Diagnose-Ring: prüft einen Agent gegen das, was die WebUI von ihm erwartet.

Die Prüfungen laufen über die Adapter-Schnittstelle, kennen also keine Hermes-Routen. Sie lesen nur; der Lauftest
ist die Ausnahme und legt eine kurze Session an (Löschen ist im Projekt verboten, sie bleibt in der Liste).
Jede Prüfung liefert `ok`, `warn` (läuft, aber anders als erwartet) oder `fail`. So zeigt sich eine Abweichung der
Hermes-API sofort, nicht erst, wenn im Chat etwas fehlt.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from .adapters import RunInput, RuntimeAdapter, UpstreamError
from .cache import TtlCache
from .events import TERMINAL_TYPES

Check = dict[str, Any]
RUN_TEST_PROMPT = "Antworte nur mit dem Wort OK."
RUN_TEST_TIMEOUT_S = 90.0


def check(cid: str, label: str, status: str, detail: str = "", ms: int | None = None) -> Check:
    return {"id": cid, "label": label, "status": status, "detail": detail, "ms": ms}


async def timed(cid: str, label: str, fn: Callable[[], Awaitable[tuple[str, str]]]) -> Check:
    """Führt eine Prüfung aus und fängt Fehler der Runtime ab: ein Fehler ist hier ein Ergebnis, kein Abbruch."""
    started = time.monotonic()
    try:
        status, detail = await fn()
    except UpstreamError as e:
        status, detail = "fail", f"{e.status}: {e.detail}"
    except Exception as e:  # noqa: BLE001 - die Diagnose darf an keiner Form scheitern
        status, detail = "fail", f"{type(e).__name__}: {e}"[:300]
    return check(cid, label, status, detail, round((time.monotonic() - started) * 1000))


def rows(payload: Any) -> list[Any] | None:
    """Liste aus einer Antwort: Hermes nennt sie `data`, Mock und ältere Formen `sessions`/`messages`/`items`."""
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("data", "sessions", "messages", "items"):
            if isinstance(payload.get(key), list):
                return payload[key]
    return None


def summarize(checks: list[Check]) -> str:
    states = {c["status"] for c in checks}
    return "fail" if "fail" in states else "warn" if states & {"warn", "slow"} else "ok"  # "slow" (Zeitlimit) zählt als Abweichung, nicht als Fehler


async def inspect(adapter: RuntimeAdapter, agent: str, *, cache: TtlCache | None = None,
                  models_ttl: float = 60.0, models_timeout: float = 8.0) -> list[Check]:
    """Alle lesenden Prüfungen eines Agents. Nach dem Erreichbarkeitstest laufen Modelle und Sessions/Verlauf parallel.

    `Modelle und Anbieter` ist die langsamste Prüfung: mit `cache` wird ihr Ergebnis `models_ttl` s wiederverwendet, und nach
    `models_timeout` s meldet sie "slow" statt zu warten (die Abfrage läuft weiter und füllt den Cache für die nächste Prüfung)."""
    out: list[Check] = []
    status = None

    async def health() -> tuple[str, str]:
        nonlocal status
        status = await adapter.probe(agent)
        if status.state != "online":
            return "fail", status.error or status.state
        return "ok", f"Version {status.version or '?'}"

    out.append(await timed("health", "Erreichbar und angemeldet", health))
    if status is None or status.state != "online":
        return out  # ohne Verbindung sind die übrigen Prüfungen sinnlos

    async def features() -> tuple[str, str]:
        need = {"runs", "stream", "stop", "approval", "sessions", "models"}
        missing = sorted(need - status.features)
        extra = sorted(status.features & {"steer", "fork", "model_lock", "reasoning", "skills", "idempotency"})
        if missing:
            return "warn", f"Fehlt laut Fähigkeiten: {', '.join(missing)}"
        return "ok", f"{len(status.features)} Fähigkeiten, u. a. {', '.join(extra) or 'nur Basis'}"

    out.append(await timed("features", "Fähigkeiten", features))

    async def models_result() -> tuple[str, str]:
        payload = await adapter.models(agent)
        providers = payload.get("providers") if isinstance(payload, dict) else None
        if isinstance(providers, list):
            usable = [p for p in providers if isinstance(p, dict) and p.get("models") and p.get("authenticated") is not False]
            if not usable:
                return "warn", "Kein Anbieter mit Modellen und gültigem Zugang"
            total = sum(len(p["models"]) for p in usable)
            return "ok", f"{len(usable)} Anbieter, {total} Modelle, aktuell {payload.get('model') or '?'}"
        flat = payload.get("models") if isinstance(payload, dict) else payload
        if isinstance(flat, list) and flat:
            return "warn", "Alte Antwortform (flache Liste), Gruppierung nach Anbieter fehlt"
        return "fail", "Antwort enthält weder `providers` noch `models`"

    async def models() -> tuple[str, str]:
        if cache is None:
            return await models_result()
        key = ("models", adapter.id, getattr(getattr(adapter, "cfg", None), "base_url", ""), agent)
        try:
            result, _ = await asyncio.wait_for(cache.get(key, models_ttl, models_result), models_timeout)
        except asyncio.TimeoutError:
            return "slow", f"Langsam: keine Antwort nach {models_timeout:g} s, die Abfrage läuft weiter"
        return result

    newest: str | None = None

    async def sessions() -> tuple[str, str]:
        nonlocal newest
        payload = await adapter.sessions(agent, limit=5, offset=0, source=None)
        items = rows(payload)
        if items is None:
            return "fail", "Antwort ist keine Liste"
        for it in items:
            if isinstance(it, dict) and isinstance(it.get("id"), str):
                newest = newest or it["id"]
        more = payload.get("has_more") if isinstance(payload, dict) else None
        return "ok", f"{len(items)} Sessions gelesen{', weitere vorhanden' if more else ''}"

    async def sessions_and_history() -> list[Check]:
        got = [await timed("sessions", "Sessions lesen", sessions)]
        if newest is None:
            return got + [check("history", "Verlauf lesen", "warn", "Noch keine Session zum Prüfen (Lauftest anlegen)")]
        return got + [await timed("history", "Verlauf lesen (Tool-Aufrufe und Ausgaben)", history)]

    async def history() -> tuple[str, str]:
        payload = await adapter.session_messages(agent, newest, limit=200, offset=None)
        items = rows(payload)
        if items is None:
            return "fail", "Antwort ist keine Liste"
        msgs = [m for m in items if isinstance(m, dict)]
        roles = {m.get("role") for m in msgs}
        calls = sum(len(m.get("tool_calls") or []) for m in msgs if m.get("role") == "assistant")
        results = [m for m in msgs if m.get("role") == "tool"]
        if calls and not results:
            return "warn", f"{calls} Tool-Aufrufe, aber keine Ergebnis-Nachrichten: Ausgaben ließen sich nicht anzeigen"
        if not roles & {"user", "assistant"}:
            return "warn", "Verlauf ohne Nutzer- oder Assistentennachrichten"
        return "ok", f"{len(msgs)} Nachrichten, {calls} Tool-Aufrufe, {len(results)} Ergebnisse"

    model_check, tail = await asyncio.gather(timed("models", "Modelle und Anbieter", models), sessions_and_history())
    return out + [model_check, *tail]


async def run_test(adapter: RuntimeAdapter, agent: str) -> list[Check]:
    """Ein echter, kurzer Lauf: Start, Ereignisstrom, Abschluss, Verlauf. Legt eine Session an."""
    out: list[Check] = []
    ctx: dict[str, Any] = {}

    async def start() -> tuple[str, str]:
        info = await adapter.start_run(agent, RunInput(RUN_TEST_PROMPT, idempotency_key=f"selbsttest-{uuid.uuid4().hex[:12]}"))
        ctx["run"], ctx["session"] = info.run_id, info.session_id
        if not info.session_id:
            return "warn", "Run gestartet, aber ohne Session-ID: Folgenachrichten begännen eine neue Session"
        return "ok", f"Run {info.run_id}, Session {info.session_id}"

    out.append(await timed("run.start", "Run starten", start))
    if "run" not in ctx:
        return out

    async def stream() -> tuple[str, str]:
        types: list[str] = []
        text = ""
        end: dict[str, Any] = {}

        async def consume() -> None:
            nonlocal text, end
            async for ev in adapter.events(agent, ctx["run"]):
                types.append(ev["type"])
                if ev["type"] == "message.delta":
                    text += ev.get("text", "")
                if ev["type"] in TERMINAL_TYPES:
                    end = ev
                    return

        try:
            await asyncio.wait_for(consume(), RUN_TEST_TIMEOUT_S)
        except asyncio.TimeoutError:
            return "fail", f"Kein Abschluss nach {int(RUN_TEST_TIMEOUT_S)} s (Ereignisse: {', '.join(types[-5:]) or 'keine'})"
        ctx["text"] = text or str(end.get("text") or "")
        if end.get("type") != "run.completed":
            return "fail", f"Lauf endete mit {end.get('type')}: {end.get('error', '')}"[:300]
        if "message.delta" not in types:
            return "warn", "Antwort kam ohne Zeichenstrom (kein message.delta): das Tippen live entfällt"
        return "ok", f"{len(types)} Ereignisse, Antwort: {ctx['text'].strip()[:60]}"

    out.append(await timed("run.stream", "Ereignisstrom bis zum Abschluss", stream))

    async def history() -> tuple[str, str]:
        if not ctx.get("session"):
            return "warn", "Übersprungen: keine Session-ID"
        # Hermes schreibt den Verlauf kurz nach dem Abschluss: einmal nachfassen.
        for attempt in range(2):
            items = rows(await adapter.session_messages(agent, ctx["session"], limit=50, offset=None)) or []
            roles = [m.get("role") for m in items if isinstance(m, dict)]
            if "assistant" in roles:
                return "ok", f"{len(items)} Nachrichten im Verlauf"
            await asyncio.sleep(1.0)
        return "warn", "Antwort steht nach 1 s noch nicht im Verlauf"

    out.append(await timed("run.history", "Antwort im Verlauf", history))
    return out
