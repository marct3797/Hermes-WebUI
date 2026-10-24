#!/usr/bin/env bash
# Trägt die API-Keys der Hermes-Profile in webui.env ein. Läuft auf dem Server der WebUI:
#     bash deploy/profile-keys.sh [Zielordner]          (Standard: ~/hermes-webui)
# Jedes Profil im Multiplex-Gateway hat sein eigenes API_SERVER_KEY in <Datenordner>/profiles/<profil>/.env.
# Gelesen wird für jeden Agent in config/hosts.json, der ein `api_key_env` hat. Die Werte werden nie ausgegeben,
# nur Profil, Name der Variablen und Länge. Überschreibt nur diese Variablen, löscht nichts (Sicherung: webui.env.bak).
home="${1:-$HOME/hermes-webui}"
data="${HERMES_DATA:-$(sed -n 's/^HERMES_DATA=//p' "$home/webui.env" 2>/dev/null | head -n1)}"
[ -n "$data" ] || { echo "HERMES_DATA fehlt (Datenordner des Hermes-Containers, enthält profiles/) in webui.env oder Umgebung"; exit 1; }
envf="$home/webui.env"

[ -f "$envf" ] || { echo "webui.env fehlt in $home (erst deploy.sh starten)"; exit 1; }

set_var() {  # set_var NAME  (Wert von stdin)
  local val; val="$(cat)"
  cp -p "$envf" "$envf.bak"
  { grep -v "^$1=" "$envf.bak"; printf '%s=%s\n' "$1" "$val"; } > "$envf.new" && chmod 600 "$envf.new" && mv "$envf.new" "$envf"
}

pairs="$(python3 - "$home/config/hosts.json" <<'PY'
import json, sys
for host in json.load(open(sys.argv[1])).get("hosts", []):
    for rt in host.get("runtimes", []):
        for a in rt.get("agents", []):
            if isinstance(a, dict) and a.get("api_key_env"):
                print(a["id"], a["api_key_env"])
PY
)"
[ -n "$pairs" ] || { echo "Kein Agent mit api_key_env in $home/config/hosts.json"; exit 1; }

missing=0
while read -r id var; do
  f="$data/profiles/$id/.env"
  v="$(sudo sed -n 's/^API_SERVER_KEY=//p' "$f" 2>/dev/null | head -n1 | tr -d "\"'\r")"
  if [ -n "$v" ]; then
    printf '%s' "$v" | set_var "$var"
    echo "$id: $var gesetzt (Länge ${#v})"
  else
    echo "$id: kein API_SERVER_KEY in $f"; missing=$((missing + 1))
  fi
  unset v
done <<< "$pairs"

if [ "$missing" -gt 0 ]; then
  echo "Dateien unter $data mit dem Namen API_SERVER_KEY (nur Pfade):"
  sudo grep -rlI API_SERVER_KEY "$data" 2>/dev/null | head -n 20
fi
