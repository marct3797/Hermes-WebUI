#!/usr/bin/env bash
# Richtet die WebUI auf Hikari ein oder aktualisiert sie. Läuft als tenjin, aus dem Repo-Ordner:
#     bash deploy/deploy.sh [Zielordner]          (Standard: ~/hermes-webui)
# Idempotent. Löscht nichts, überschreibt keine vorhandene Config und gibt keine Geheimnisse aus.
# Zielordner: config/ (hosts.json, ui.json, Sigils), data/ (Audit-Log), webui.env (chmod 600).
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
home="${1:-$HOME/hermes-webui}"
envf="$home/webui.env"

docker=(docker); docker info >/dev/null 2>&1 || docker=(sudo docker)
mkdir -p "$home/config" "$home/data"

# Config nur anlegen, nie überschreiben (cp -n). Die Beispiel-Sigils sind Marcs japanisches Set, optional.
[ -f "$home/config/hosts.json" ] || cp "$here/hosts.json" "$home/config/hosts.json"
cp -rn "$here/../backend/examples/japan/." "$home/config/" 2>/dev/null

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

# Key des Container-Gateways: aus der Umgebung des laufenden Containers, nur wenn noch keiner eingetragen ist.
if [ -z "$(get HERMES_KEY_HIKARI)" ]; then
  "${docker[@]}" exec hermes-agents sh -c 'printf %s "$API_SERVER_KEY"' 2>/dev/null | set_var HERMES_KEY_HIKARI
fi

missing=""
for v in HERMES_KEY_HIKARI FORGEJO_OIDC_CLIENT_ID FORGEJO_OIDC_CLIENT_SECRET OIDC_ALLOWED_SUB; do
  [ -n "$(get $v)" ] || missing="$missing $v"
done
if [ -n "$missing" ]; then
  echo "FEHLT in $envf:$missing"
  echo "Eintragen (ohne Ausgabe der Werte), dann dieses Skript erneut starten."
  exit 2
fi

port="$(get WEBUI_PORT)"; port="${port:-8420}"
export WEBUI_HOME="$home" WEBUI_UID="$(id -u)" WEBUI_GID="$(id -g)"
( cd "$here" && "${docker[@]}" compose up -d --build --force-recreate ) || { echo "docker compose fehlgeschlagen"; exit 1; }

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
    echo "WebUI läuft auf 127.0.0.1:$port (Container hermes-webui)"; exit 0
  fi
  sleep 2
done
echo "Keine Antwort auf /healthz. Log:"; "${docker[@]}" logs --tail 40 hermes-webui 2>&1 | sed 's/\(secret\|key\|token\)=[^ ]*/\1=…/Ig'
exit 1
