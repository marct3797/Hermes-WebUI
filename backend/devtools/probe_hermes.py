"""Prüft einen echten Hermes-API-Server und gibt nur die FORM der Antworten aus (kein Inhalt, nie den Key).

Aufruf auf dem Rechner, der Hermes erreicht (Key nur über die Umgebung, nie als Argument):

    HERMES_KEY_HIKARI=... python backend/devtools/probe_hermes.py --base http://127.0.0.1:9121 --profile default

Texte erscheinen nur als Länge, kurze Kennwörter (Event- und Statusnamen) bleiben lesbar. Der Lauf schickt
einen harmlosen Prompt, löst keine Freigabe aus, löscht nichts und beendet seine Läufe selbst.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from typing import Any

import httpx

KEYWORD = re.compile(r"^[a-z0-9_.:\-]{1,32}$")


def shape(value: Any, depth: int = 0) -> Any:
    """Ersetzt Texte durch ihre Länge; kurze Kennwörter bleiben, damit Namen und Status sichtbar sind."""
    if isinstance(value, str):
        return value if KEYWORD.match(value) else f"<str len={len(value)}>"
    if isinstance(value, dict):
        return {k: shape(v, depth + 1) for k, v in list(value.items())[:40]} if depth < 5 else "<dict>"
    if isinstance(value, list):
        return [shape(v, depth + 1) for v in value[:3]] + ([f"<+{len(value) - 3} weitere>"] if len(value) > 3 else [])
    return value


def url(base: str, profile: str | None, path: str) -> str:
    return f"{base.rstrip('/')}{f'/p/{profile}' if profile else ''}{path}"


async def get_json(http: httpx.AsyncClient, label: str, u: str, report: dict, headers: dict) -> Any:
    try:
        r = await http.get(u, headers=headers)
    except httpx.HTTPError as e:
        report[label] = {"fehler": type(e).__name__}
        return None
    try:
        body: Any = r.json()
    except ValueError:
        body = f"<kein JSON, {len(r.content)} Byte>"
    report[label] = {"status": r.status_code, "form": shape(body)}
    return body if r.status_code < 400 else None


async def read_events(http: httpx.AsyncClient, u: str, headers: dict, limit_s: float) -> dict:
    out: dict[str, Any] = {"frames": [], "kommentare": 0, "event_zeilen": 0}
    try:
        async with http.stream("GET", u, headers={**headers, "Accept": "text/event-stream"},
                               timeout=httpx.Timeout(10.0, read=limit_s)) as r:
            out["status"] = r.status_code
            if r.status_code >= 400:
                await r.aread()
                return out
            data: list[str] = []
            async for line in r.aiter_lines():
                if line.startswith(":"):
                    out["kommentare"] += 1
                elif line.startswith("event:"):
                    out["event_zeilen"] += 1
                elif line.startswith("data:"):
                    data.append(line[5:].lstrip())
                elif line == "" and data:
                    raw = "\n".join(data)
                    data = []
                    try:
                        out["frames"].append(shape(json.loads(raw)))
                    except ValueError:
                        out["frames"].append(f"<kein JSON, {len(raw)} Zeichen>")
                    last = out["frames"][-1]
                    if isinstance(last, dict) and str(last.get("event", "")).startswith("run.") and \
                            last.get("event") in ("run.completed", "run.failed", "run.stopped"):
                        break
    except httpx.TimeoutException:
        out["abbruch"] = "Zeitlimit"
    except httpx.HTTPError as e:
        out["abbruch"] = type(e).__name__
    return out


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:9121")
    ap.add_argument("--profile", default="default", help="Profil hinter /p/<profil>; leer = ohne Multiplex")
    ap.add_argument("--key-env", default=None, help="Standard: HERMES_KEY_<PROFIL> (default: HERMES_KEY_HIKARI)")
    ap.add_argument("--wait", type=float, default=60.0, help="Sekunden, die der Ereignisstrom höchstens gelesen wird")
    args = ap.parse_args()

    profile_arg = args.profile or "default"
    key_env = args.key_env or ("HERMES_KEY_HIKARI" if profile_arg == "default" else f"HERMES_KEY_{profile_arg.upper()}")
    key = os.environ.get(key_env, "")
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    profile = args.profile or None
    report: dict[str, Any] = {"key_gesetzt": bool(key), "profil": profile}

    async with httpx.AsyncClient(timeout=15.0) as http:
        # Ohne Key: erreichbar und Version
        await get_json(http, "health_ohne_key", f"{args.base.rstrip('/')}/health", report, {})
        await get_json(http, "capabilities", url(args.base, profile, "/v1/capabilities"), report, headers)
        await get_json(http, "modelle", url(args.base, profile, "/api/model/options"), report, headers)
        await get_json(http, "sessions", url(args.base, profile, "/api/sessions?limit=3"), report, headers)

        # Ein kurzer Lauf: Antwortform, Ereignisse, Einmal-Abo
        started = None
        try:
            r = await http.post(url(args.base, profile, "/v1/runs"), headers=headers,
                                json={"input": "Antworte nur mit dem Wort: ok"})
            body = r.json() if r.content else {}
            report["run_start"] = {"status": r.status_code, "form": shape(body)}
            started = body.get("run_id") if isinstance(body, dict) else None
        except (httpx.HTTPError, ValueError) as e:
            report["run_start"] = {"fehler": type(e).__name__}

        if started:
            events_u = url(args.base, profile, f"/v1/runs/{started}/events")
            report["ereignisse"] = await read_events(http, events_u, headers, args.wait)
            second = await read_events(http, events_u, headers, 5.0)
            report["zweites_abo"] = {"status": second.get("status"), "frames": len(second["frames"]),
                                     "abbruch": second.get("abbruch")}
            await get_json(http, "run_status", url(args.base, profile, f"/v1/runs/{started}"), report, headers)

            # Stopp einer schon beendeten Anfrage: zeigt nur, wie der Server darauf antwortet
            try:
                r = await http.post(url(args.base, profile, f"/v1/runs/{started}/stop"), headers=headers, json={})
                report["stop_nach_ende"] = {"status": r.status_code}
            except httpx.HTTPError as e:
                report["stop_nach_ende"] = {"fehler": type(e).__name__}

    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
