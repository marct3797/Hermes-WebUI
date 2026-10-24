#!/usr/bin/env bash
# Richtet die WebUI auf dem Server ein oder aktualisiert sie. Läuft als normaler Benutzer (nicht root), aus dem Repo-Ordner:
#     bash deploy/deploy.sh [Zielordner]          (Standard: ~/hermes-webui)
# Idempotent. Löscht nichts, überschreibt keine vorhandene Config und gibt keine Geheimnisse aus.
# Zielordner: config/ (hosts.json, ui.json, Sigils), data/ (Audit-Log), webui.env (chmod 600).
umask 077   # Verzeichnisse und Dateien mit Geheimnissen nie für andere lesbar, auch nicht kurzzeitig
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
home="${1:-$HOME/hermes-webui}"
envf="$home/webui.env"

docker=(docker); docker info >/dev/null 2>&1 || docker=(sudo docker)
mkdir -p "$home/config" "$home/data"

# Config nur anlegen, nie überschreiben. hosts.json ist ein Beispiel zum Anpassen; ein Gedächtnis-Anbieter (memory.json, siehe
# deploy/memory.example.json), ein Wissens-Anbieter (knowledge.json, siehe backend/knowledge.example.json) und ein Beispiel-Theme (WITH_EXAMPLE_THEME=1) sind optional.
[ -f "$home/config/hosts.json" ] || cp "$here/hosts.example.json" "$home/config/hosts.json"
[ "${WITH_EXAMPLE_THEME:-0}" = 1 ] && cp -rn "$here/../backend/examples/japan/." "$home/config/" 2>/dev/null

if [ ! -f "$envf" ]; then
  ( umask 077; cp "$here/webui.env.example" "$envf" )
fi
chmod 600 "$envf"

get() { sed -n "s/^$1=//p" "$envf" | head -n1; }
set_var() {  # set_var NAME  (Wert von stdin; landet nie in argv oder Ausgabe)
  local val; val="$(cat)"
  cp -p "$envf" "$envf.bak"
  { grep -v "^$1=" "$envf.bak"; printf '%s=%s\n' "$1" "$val"; } > "$envf.new" && chmod 600 "$envf.new" && mv "$envf.new" "$envf"
}

# Variablen, die hosts.json je Runtime verlangt (api_key_env). Multiplex-Gateways im Container: Key aus dessen Umgebung holen,
# wenn HERMES_CONTAINER in webui.env steht und noch kein Key eingetragen ist.
runtime_vars() { python3 - "$home/config/hosts.json" "$1" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
for host in data.get("hosts", []):
    for rt in host.get("runtimes", []):
        if rt.get("api_key_env") and (sys.argv[2] == "all" or rt.get("multiplex")):
            print(rt["api_key_env"])
PY
}
agent_vars() { python3 - "$home/config/hosts.json" <<'PY'
import json, sys
for host in json.load(open(sys.argv[1])).get("hosts", []):
    for rt in host.get("runtimes", []):
        for a in rt.get("agents", []):
            if isinstance(a, dict) and a.get("api_key_env"):
                print(a["api_key_env"])
PY
}
container="$(get HERMES_CONTAINER)"
if [ -n "$container" ]; then
  for v in $(runtime_vars multiplex); do
    [ -n "$(get "$v")" ] || "${docker[@]}" exec "$container" sh -c 'printf %s "$API_SERVER_KEY"' 2>/dev/null | set_var "$v"
  done
fi

missing=""
# OIDC: neue Namen (HERMES_WEBUI_OIDC_*) oder die älteren Aliase (FORGEJO_*, OIDC_ALLOWED_SUB) genügen.
need_any() { [ -n "$(get "$1")" ] || [ -n "$(get "$2")" ] || missing="$missing $1"; }
need_any HERMES_WEBUI_OIDC_ISSUER FORGEJO_ISSUER
need_any HERMES_WEBUI_OIDC_CLIENT_ID FORGEJO_OIDC_CLIENT_ID
need_any HERMES_WEBUI_OIDC_CLIENT_SECRET FORGEJO_OIDC_CLIENT_SECRET
need_any HERMES_WEBUI_OIDC_ALLOWED_SUB OIDC_ALLOWED_SUB
for v in $(runtime_vars all); do [ -n "$(get "$v")" ] || missing="$missing $v"; done
for v in $(agent_vars); do
  [ -n "$(get "$v")" ] || echo "HINWEIS: $v fehlt in $envf; für dieses Profil gilt dann der Key der Runtime (bash deploy/profile-keys.sh trägt ihn ein)."
done
if [ -n "$missing" ]; then
  echo "FEHLT in $envf:$missing"
  echo "Eintragen (ohne Ausgabe der Werte), dann dieses Skript erneut starten."
  exit 2
fi

port="$(get WEBUI_PORT)"; port="${port:-8420}"
export WEBUI_HOME="$home" WEBUI_UID="$(id -u)" WEBUI_GID="$(id -g)"
# Eintrag "name:ip" für Container, die den Namen des OIDC-Anbieters nicht selbst auflösen (z. B. nur im VPN gültig). Optional.
export WEBUI_EXTRA_HOST; WEBUI_EXTRA_HOST="$(get WEBUI_EXTRA_HOST)"
export BUILD_ID; BUILD_ID="$(git -C "$here" rev-parse --short HEAD 2>/dev/null)"   # steht danach in der Seitenleiste
echo "Baue Stand ${BUILD_ID:-unbekannt} (Branch $(git -C "$here" rev-parse --abbrev-ref HEAD 2>/dev/null))"
( cd "$here" && "${docker[@]}" compose up -d --build --force-recreate ) || { echo "docker compose fehlgeschlagen"; exit 1; }

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
    echo "WebUI läuft auf 127.0.0.1:$port (Container hermes-webui), Stand ${BUILD_ID:-unbekannt}"; exit 0
  fi
  sleep 2
done
echo "Keine Antwort auf /healthz. Log:"; "${docker[@]}" logs --tail 40 hermes-webui 2>&1 | sed 's/\(secret\|key\|token\)=[^ ]*/\1=…/Ig'
exit 1
