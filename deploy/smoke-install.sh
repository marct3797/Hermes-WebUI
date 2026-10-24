#!/usr/bin/env bash
# Frische Installation ohne Docker und ohne eigene Dateien: neues venv, Wheel aus ./backend, Minimalvorlage, Start, Prüfungen.
#     bash deploy/smoke-install.sh [gebautes-Frontend]      (z. B. frontend/dist; ohne Angabe wird die Auslieferung nicht geprüft)
# Zeigt, dass der Quellstand für sich allein läuft (nichts aus dem Arbeitsordner, keine eigene Config). Docker prüft es nicht.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
static="${1:-}"
work="$(mktemp -d)"; pid=""
trap '[ -z "$pid" ] || kill "$pid" 2>/dev/null; rm -rf "$work"' EXIT
fail() { echo "FEHLER: $*" >&2; [ ! -f "$work/log" ] || sed 's/^/  | /' "$work/log" | tail -n 20 >&2; exit 1; }

python3 -m venv "$work/venv"
"$work/venv/bin/pip" install -q "$root/backend" || fail "pip install ./backend"
mkdir "$work/config" "$work/data"
cp "$here/hosts.example.json" "$work/config/hosts.json"
port="$("$work/venv/bin/python" -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"

# Nur Platzhalter: der Start verlangt eine Anmeldung, prüft aber nicht, ob der Anbieter erreichbar ist.
export HERMES_WEBUI_ENV=prod HERMES_WEBUI_AUTH_MODE=oidc HERMES_WEBUI_PUBLIC_URL=https://webui.example.test HERMES_WEBUI_ALLOWED_HOSTS=127.0.0.1,localhost
export HERMES_WEBUI_OIDC_ISSUER=https://id.invalid HERMES_WEBUI_OIDC_CLIENT_ID=smoke HERMES_WEBUI_OIDC_CLIENT_SECRET=smoke HERMES_WEBUI_OIDC_ALLOWED_SUB=smoke
export HERMES_KEY_LOCAL=smoke-key-0123456789
export HERMES_WEBUI_HOSTS_FILE="$work/config/hosts.json" HERMES_WEBUI_AUDIT_FILE="$work/data/audit.log" HERMES_WEBUI_ROOMS_DB="$work/data/rooms.db" HERMES_WEBUI_SOUL_DIR="$work/data/soul"
[ -z "$static" ] || export HERMES_WEBUI_STATIC_DIR="$(cd "$static" && pwd)"

cd "$work"   # nicht im Repo starten: es zählt, was pip installiert hat
"$work/venv/bin/uvicorn" app.main:app_factory --factory --host 127.0.0.1 --port "$port" >"$work/log" 2>&1 &
pid=$!
for _ in $(seq 40); do curl -fs "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && break; kill -0 "$pid" 2>/dev/null || fail "Server beendet"; sleep 0.5; done
code() { curl -s -o "$work/body" -w '%{http_code}' "$@"; }

[ "$(code "http://127.0.0.1:$port/healthz")" = 200 ] || fail "/healthz"
[ "$(code "http://127.0.0.1:$port/bff/me")" = 401 ] || fail "/bff/me ohne Anmeldung muss 401 sein"
[ "$(code "http://127.0.0.1:$port/bff/hosts")" = 401 ] || fail "/bff/hosts ohne Anmeldung muss 401 sein"
w=(-X PUT -H 'Content-Type: application/json' -d '{}' "http://127.0.0.1:$port/bff/h/local/hermes/default/config")
[ "$(code "${w[@]}")" = 403 ] || fail "Schreiben ohne CSRF-Header muss 403 sein"
[ "$(code -H 'X-Requested-With: hermes-webui' "${w[@]}")" = 401 ] || fail "Schreiben ohne Anmeldung muss 401 sein"
if [ -n "$static" ]; then
  [ "$(code "http://127.0.0.1:$port/")" = 200 ] && grep -qi '<div id="root"' "$work/body" || fail "Startseite wird nicht ausgeliefert"
fi
grep -qi 'traceback' "$work/log" && fail "Traceback im Log"
echo "OK: frische Installation läuft (Port $port, ${static:+mit Frontend, }Minimalvorlage hosts.example.json)"
