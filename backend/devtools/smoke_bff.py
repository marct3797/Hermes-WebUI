"""Rauchtest durch das BFF: Status, ein kurzer Lauf, Ereignisstrom. Gibt nur Formen und Längen aus, nie Texte.

Gedacht für eine laufende Instanz ohne Login (HERMES_WEBUI_ENV=dev, AUTH_MODE=none, nur Loopback), z. B. einen
Wegwerf-Container neben der echten Instanz:

    python backend/devtools/smoke_bff.py --base http://127.0.0.1:8421 --agent inari
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys

import httpx

HEADERS = {"X-Requested-With": "hermes-webui"}


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8421")
    ap.add_argument("--host", default="hikari")
    ap.add_argument("--runtime", default="hermes")
    ap.add_argument("--agent", default="inari")
    ap.add_argument("--text", default="Antworte mit genau einem Wort: ok.")
    ap.add_argument("--wait", type=float, default=90.0)
    ap.add_argument("--twice", action="store_true", help="zweite Nachricht in derselben Session senden")
    args = ap.parse_args()
    api = f"{args.base.rstrip('/')}/bff/h/{args.host}/{args.runtime}/{args.agent}"
    ok = True

    async with httpx.AsyncClient(timeout=20.0, headers=HEADERS) as http:
        r = await http.get(f"{args.base.rstrip('/')}/healthz")
        print(f"healthz            {r.status_code}")
        r = await http.get(f"{args.base.rstrip('/')}/bff/hosts")
        print(f"hosts              {r.status_code}", [f"{h['id']}:{h.get('status')}" for h in r.json().get("hosts", [])] if r.is_success else r.text[:120])
        r = await http.get(f"{api}/status")
        st = r.json() if r.is_success else {}
        print(f"status             {r.status_code} state={st.get('state')} online={st.get('online')} version={st.get('version')} features={len(st.get('features', []))}")
        ok &= bool(st.get("online"))
        r = await http.get(f"{api}/sessions")
        body = r.json() if r.is_success else {}
        n = len(body["sessions"]) if isinstance(body, dict) and isinstance(body.get("sessions"), list) else None
        print(f"sessions           {r.status_code}", f"{n} Einträge" if n is not None else r.text[:120])

        r = await http.post(f"{api}/runs", json={"text": args.text})
        print(f"run starten        {r.status_code}", {k: bool(v) for k, v in r.json().items()} if r.is_success else r.text[:200])
        if not r.is_success:
            return 1
        run = r.json()
        types: list[str] = []
        chars = 0
        end = None
        try:
            async with http.stream("GET", f"{api}/runs/{run['run_id']}/events", timeout=args.wait) as s:
                print(f"events             {s.status_code}")
                async for line in s.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    ev = json.loads(line[5:])
                    types.append(ev.get("type", "?"))
                    if ev.get("type") in ("message.delta", "text.delta"):
                        chars += len(str(ev.get("text") or ev.get("delta") or ""))
                    if ev.get("type") in ("run.completed", "run.failed", "run.stopped", "stream.error"):
                        end = ev
                        break
        except httpx.TimeoutException:
            print("events             Zeitlimit")
        counts = {t: types.count(t) for t in dict.fromkeys(types)}
        print("ereignisse        ", counts, f"Textlänge={chars}")
        if end is None or end.get("type") != "run.completed":
            ok = False
            print("ende               ", end.get("type") if end else "kein Ende", "|", str(end.get("error", ""))[:300] if end else "")
        else:
            print("ende                run.completed")
    if args.twice:
        async with httpx.AsyncClient(timeout=20.0, headers=HEADERS) as http:
            sid = run.get("session_id")
            print(f"session_id nach Start  {'ja' if sid else 'NEIN'}")
            ok &= bool(sid)
            if sid:
                r = await http.post(f"{api}/runs", json={"text": args.text, "session_id": sid})
                second = r.json() if r.is_success else {}
                same = second.get("session_id") == sid
                print(f"zweiter Lauf       {r.status_code} gleiche Session={same}")
                ok &= r.is_success and same
                if r.is_success:
                    try:
                        async with http.stream("GET", f"{api}/runs/{second['run_id']}/events", timeout=args.wait) as s:
                            async for line in s.aiter_lines():
                                if line.startswith("data:") and json.loads(line[5:]).get("type") in ("run.completed", "run.failed", "stream.error"):
                                    print("zweiter Lauf Ende ", json.loads(line[5:]).get("type"))
                                    break
                    except httpx.TimeoutException:
                        print("zweiter Lauf       Zeitlimit")
    print("ERGEBNIS", "ok" if ok else "FEHLER")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
