#!/usr/bin/env python3
"""Einrichtungsassistent im Terminal: schreibt config/hosts.json und webui.env und prüft die Verbindungen.

    python3 deploy/setup.py [Zielordner]          (Standard: ~/hermes-webui)

Läuft ohne Abhängigkeiten. Vorhandenes wird erkannt und nie überschrieben: eine bestehende hosts.json bleibt, die webui.env wird
um die geänderten Werte ergänzt (Kommentare und fremde Variablen bleiben, die alte Fassung liegt als webui.env.bak daneben).
Geheimnisse werden nur über getpass gelesen, nie angezeigt und nie als Argument übergeben. Danach: bash deploy/deploy.sh <Zielordner>.
Bewusst ohne Browserseite: ein Assistent im Browser wäre beim ersten Start eine Schreibfläche ohne Anmeldung.
"""
from __future__ import annotations

import getpass
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
AGENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")  # wie backend/app/registry.py
PROVIDER_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
GATEWAY_DEFAULT, DASHBOARD_DEFAULT = "http://127.0.0.1:8642", "http://127.0.0.1:9119"


# --- webui.env ---------------------------------------------------------------------------------------------
def read_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if path.exists():
        for line in path.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip()
    return out


def merge_env(text: str, updates: dict[str, str]) -> str:
    """Setzt Werte in einen vorhandenen Text: aktive Zeile ersetzen, sonst auskommentierte Vorlagenzeile, sonst anhängen."""
    lines = text.splitlines()
    for key, value in updates.items():
        active = re.compile(rf"^{re.escape(key)}=")
        commented = re.compile(rf"^#\s*{re.escape(key)}=")
        for pattern in (active, commented):
            hit = next((i for i, line in enumerate(lines) if pattern.match(line)), None)
            if hit is not None:
                lines[hit] = f"{key}={value}"
                break
        else:
            lines.append(f"{key}={value}")
    return "\n".join(lines) + "\n"


def write_private(path: Path, text: str) -> None:
    """Datei mit 0600 anlegen (nie kurz offener) und per Umbenennen austauschen."""
    tmp = path.with_name(path.name + ".new")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(tmp, path)


# --- Verbindungsprüfungen ----------------------------------------------------------------------------------
def fetch(url: str, headers: dict[str, str] | None = None, timeout: float = 5.0) -> tuple[bool, str, dict | None]:
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - Ziel gibt der Betreiber selbst an
            raw = r.read(1_000_000)
            try:
                return True, f"HTTP {r.status}", json.loads(raw)
            except ValueError:
                return True, f"HTTP {r.status}", None
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}" + (" (Key oder Token abgelehnt)" if e.code in (401, 403) else ""), None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return False, f"nicht erreichbar ({getattr(e, 'reason', e)})", None


def check_gateway(url: str, key: str) -> tuple[bool, str]:
    ok, msg, _ = fetch(url.rstrip("/") + "/v1/capabilities", {"Authorization": f"Bearer {key}"} if key else None)
    return ok, f"Gateway {url}: {msg}"


def check_dashboard(url: str, token: str) -> tuple[bool, str]:
    ok, msg, _ = fetch(url.rstrip("/") + "/api/profiles", {"X-Hermes-Session-Token": token} if token else None)
    return ok, f"Dashboard {url}: {msg}"


def check_oidc(issuer: str) -> tuple[bool, str, bool | None]:
    """Erreichbarkeit der Discovery und ob der Anbieter `auth_time` als Claim nennt (Beleg für die Frische der Anmeldung)."""
    ok, msg, body = fetch(issuer.rstrip("/") + "/.well-known/openid-configuration")
    if not ok or not isinstance(body, dict):
        return False, f"Anmeldeanbieter {issuer}: {msg if not ok else 'keine gültige Discovery'}", None
    if str(body.get("issuer", "")).rstrip("/") != issuer.rstrip("/"):
        return False, f"Anmeldeanbieter {issuer}: meldet den Issuer „{body.get('issuer')}“, die Token-Prüfung würde scheitern", None
    claims = body.get("claims_supported")
    return True, f"Anmeldeanbieter {issuer}: {msg}", ("auth_time" in claims) if isinstance(claims, list) else None


# --- Dialog ------------------------------------------------------------------------------------------------
def main(argv: list[str] | None = None, ask=input, secret=getpass.getpass, out=print) -> int:
    args = [a for a in (sys.argv[1:] if argv is None else argv) if not a.startswith("-")]
    target = Path(args[0]).expanduser() if args else Path.home() / "hermes-webui"
    hosts_file, env_file = target / "config" / "hosts.json", target / "webui.env"
    old = read_env(env_file)
    updates: dict[str, str] = {}
    results: list[tuple[bool, str]] = []

    def yes(question: str, default: bool) -> bool:
        answer = ask(f"{question} [{'J/n' if default else 'j/N'}] ").strip().lower()
        return default if not answer else answer in ("j", "ja", "y", "yes")

    def text(question: str, default: str = "", check=None, why: str = "") -> str:
        while True:
            value = ask(f"{question}{f' [{default}]' if default else ''}: ").strip() or default
            if check is None or check(value):
                return value
            out(f"  Ungültig. {why}")

    https_host = lambda v: v.startswith("https://") and bool(urlparse(v).hostname)  # noqa: E731
    http_host = lambda v: urlparse(v).scheme in ("http", "https") and bool(urlparse(v).hostname)  # noqa: E731

    out(f"Einrichtung in {target}\nVorhandenes bleibt erhalten; Geheimnisse werden nicht angezeigt.\n")

    # 1. Hermes-Gateway und Dashboard
    gateway = gw_key = dash_url = dash_token = ""
    if hosts_file.exists():
        out(f"hosts.json ist vorhanden und bleibt unverändert ({hosts_file}). Weitere Rechner: bash deploy/add-host.sh")
        try:
            rt = json.loads(hosts_file.read_text())["hosts"][0]["runtimes"][0]
            gateway, gw_key = rt.get("base_url", ""), old.get(rt.get("api_key_env", ""), "")
            dash = rt.get("dashboard") or {}
            dash_url, dash_token = dash.get("base_url", ""), old.get(dash.get("token_env", ""), "")
        except (ValueError, KeyError, IndexError, AttributeError):
            out("  Der erste Eintrag der hosts.json ließ sich nicht lesen; die Verbindungsprüfung dafür entfällt.")
        new_hosts = None
    else:
        gateway = text("Gateway-URL von Hermes (API-Server des Agents)", GATEWAY_DEFAULT, http_host, "Erwartet wird http:// oder https:// mit Rechnername.")
        profile = text("Profilname", "default", AGENT_RE.match, "Buchstaben, Ziffern, _ und -; so heißt der Profilordner.")
        gw_key = secret("API_SERVER_KEY des Gateways (Eingabe bleibt unsichtbar, leer = keiner): ")
        dashboard = {}
        if yes("Dashboard (`hermes dashboard`) anbinden? Es liefert SOUL, Einstellungen, Keys, Skills, Zeitpläne", True):
            dash_url = text("Dashboard-URL", DASHBOARD_DEFAULT, http_host, "Erwartet wird http:// oder https:// mit Rechnername.")
            dash_token = secret("Dashboard-Token (leer = keiner, genügt auf Loopback): ")
            dashboard = {"dashboard": {"base_url": dash_url, **({"token_env": "HERMES_DASHBOARD_TOKEN"} if dash_token else {})}}
        template = json.loads((HERE / "hosts.example.json").read_text())
        rt = template["hosts"][0]["runtimes"][0]
        rt.update(base_url=gateway, agents=[profile], **dashboard)
        new_hosts = template
        if gw_key:
            updates["HERMES_KEY_LOCAL"] = gw_key
        if dash_token:
            updates["HERMES_DASHBOARD_TOKEN"] = dash_token

    # 2. Anmeldung
    have_oidc = all(old.get(k) for k in ("HERMES_WEBUI_OIDC_ISSUER", "HERMES_WEBUI_OIDC_CLIENT_ID", "HERMES_WEBUI_OIDC_CLIENT_SECRET", "HERMES_WEBUI_OIDC_ALLOWED_SUB")) \
        and old.get("HERMES_WEBUI_PUBLIC_URL", "").startswith("https://")
    issuer = old.get("HERMES_WEBUI_OIDC_ISSUER", "")
    if have_oidc and not yes(f"Die Anmeldung über {issuer} ist eingerichtet. Ändern?", False):
        pass
    else:
        out("\nAnmeldung über einen OIDC-Anbieter (z. B. Forgejo). Die WebUI läuft in prod nur mit https.")
        public = text("Öffentliche URL der WebUI", "", https_host, "Die URL muss mit https:// beginnen.").rstrip("/")
        issuer = text("OIDC-Anbieter (Issuer-URL)", "", https_host, "In prod muss auch der Anbieter https verwenden.").rstrip("/")
        client_id = text("Client-ID der OAuth-App", "", bool, "Darf nicht leer sein.")
        client_secret = secret("Client-Secret (unsichtbar): ")
        sub = text("Erlaubte Kennung(en) (`sub` des ID-Tokens, mehrere kommagetrennt)", "", bool, "Ohne Eintrag käme niemand hinein.")
        updates.update(HERMES_WEBUI_ENV="prod", HERMES_WEBUI_AUTH_MODE="oidc", HERMES_WEBUI_PUBLIC_URL=public, HERMES_WEBUI_OIDC_ISSUER=issuer,
                       HERMES_WEBUI_OIDC_CLIENT_ID=client_id, HERMES_WEBUI_OIDC_CLIENT_SECRET=client_secret, HERMES_WEBUI_OIDC_ALLOWED_SUB=sub,
                       HERMES_WEBUI_ALLOWED_HOSTS=f"{urlparse(public).hostname},127.0.0.1,localhost")
        out(f"  Redirect-URI der OAuth-App: {public}/auth/callback")

    # 3. Neue Anmeldung vor riskanten Aktionen (Step-up)
    if yes("\nIst die WebUI nur in einem privaten Netz erreichbar (kein Zugriff aus dem Internet)?", False):
        if yes("  Die neue Anmeldung vor riskanten Aktionen (Terminal, SOUL, Schlüssel) abschalten? Dann zählt nur die normale Anmeldung", True):
            updates["HERMES_WEBUI_STEP_UP"] = "off"
    elif old.get("HERMES_WEBUI_STEP_UP") == "off":
        updates["HERMES_WEBUI_STEP_UP"] = "on"

    # 4. Anbieter ausblenden
    hidden_old = old.get("HERMES_WEBUI_HIDDEN_PROVIDERS", "")
    raw = ask(f"\nAnbieter ausblenden (Kennungen kommagetrennt, z. B. nous){f' [{hidden_old}]' if hidden_old else ''}: ").strip()
    hidden = ",".join(p for p in (s.strip().lower() for s in raw.split(",")) if p) or hidden_old
    bad = [p for p in hidden.split(",") if p and not PROVIDER_RE.match(p)]
    if bad:
        out(f"  Ignoriert (keine gültige Kennung): {', '.join(bad)}")
        hidden = ",".join(p for p in hidden.split(",") if p and PROVIDER_RE.match(p))
    if hidden and hidden != hidden_old:
        updates["HERMES_WEBUI_HIDDEN_PROVIDERS"] = hidden

    # 5. Prüfen
    out("\nPrüfung der Verbindungen:")
    if gateway:
        results.append(check_gateway(gateway, gw_key))
    if dash_url:
        results.append(check_dashboard(dash_url, dash_token))
    proof = None
    if issuer:
        ok, msg, proof = check_oidc(issuer)
        results.append((ok, msg))
    for ok, msg in results:
        out(f"  {'OK     ' if ok else 'FEHLER '}{msg}")
    if proof is True:
        out("  Step-up: Der Anbieter nennt `auth_time`, die Frische der Anmeldung ist belegt.")
    elif proof is False:
        out("  Step-up: Der Anbieter nennt kein `auth_time`; die Frische der Anmeldung ist nicht belegt, die WebUI verlässt sich auf prompt=login (siehe SECURITY.md, Seite System).")
    elif issuer:
        out("  Step-up: Ob der Anbieter `auth_time` nennt, ließ sich nicht feststellen.")
    failed = any(not ok for ok, _ in results)
    if failed and not yes("Es gab Fehler. Trotzdem schreiben?", False):
        out("Nichts geschrieben.")
        return 1

    # 6. Schreiben
    old_umask = os.umask(0o077)
    try:
        (target / "config").mkdir(parents=True, exist_ok=True)
        (target / "data").mkdir(exist_ok=True)
        if new_hosts is not None:
            write_private(hosts_file, json.dumps(new_hosts, indent=2) + "\n")
        if updates:
            base = env_file.read_text() if env_file.exists() else (HERE / "webui.env.example").read_text()
            if env_file.exists():
                write_private(env_file.with_name(env_file.name + ".bak"), base)
            write_private(env_file, merge_env(base, updates))
    finally:
        os.umask(old_umask)
    out(f"\nGeschrieben: {', '.join(str(p) for p in (hosts_file if new_hosts is not None else None, env_file if updates else None) if p) or 'nichts (alles war schon eingerichtet)'}")
    out(f"Nächster Schritt:  bash deploy/deploy.sh {target}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (KeyboardInterrupt, EOFError):
        sys.exit("\nAbgebrochen, nichts geschrieben.")
