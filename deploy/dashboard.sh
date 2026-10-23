#!/usr/bin/env bash
# Startet das Hermes-Dashboard im Container hermes-agents für die WebUI (SOUL und Profil-Einstellungen). Läuft als tenjin auf Hikari:
#     bash deploy/dashboard.sh [Zielordner]          (Standard: ~/hermes-webui)
# Das Dashboard lauscht nur auf 127.0.0.1:9122 (9119 gehört dem Host-Dashboard) und verlangt einen festen Token. Der Token wird
# einmal erzeugt und als HERMES_DASHBOARD_TOKEN in webui.env abgelegt, nie ausgegeben. Eintrag "dashboard" in config/hosts.json
# kommt hinzu, falls er fehlt (Sicherung: hosts.json.bak). Löscht nichts. Mehrfach ausführbar: läuft das Dashboard schon, passiert nichts.
# Das Dashboard läuft als Prozess im Container und endet mit ihm: nach einem Neustart von hermes-agents das Skript erneut starten.
home="${1:-$HOME/hermes-webui}"
envf="$home/webui.env"
hosts="$home/config/hosts.json"
port="${DASHBOARD_PORT:-9122}"
name="${HERMES_CONTAINER:-hermes-agents}"

[ -f "$envf" ] || { echo "webui.env fehlt in $home (erst deploy.sh starten)"; exit 1; }

docker=(docker); docker info >/dev/null 2>&1 || docker=(sudo --preserve-env=HERMES_DASHBOARD_SESSION_TOKEN docker)
get() { sed -n "s/^$1=//p" "$envf" | head -n1; }
set_var() {  # set_var NAME  (Wert von stdin; landet nie in argv oder Ausgabe)
  local val; val="$(cat)"
  cp -p "$envf" "$envf.bak"
  { grep -v "^$1=" "$envf.bak"; printf '%s=%s\n' "$1" "$val"; } > "$envf.new" && chmod 600 "$envf.new" && mv "$envf.new" "$envf"
}
# Fragt /api/profiles mit dem Token ab (Header über stdin, nicht über die Befehlszeile).
profiles() { printf 'X-Hermes-Session-Token: %s\n' "$(get HERMES_DASHBOARD_TOKEN)" | curl -fsS --max-time 5 -H @- "http://127.0.0.1:$port/api/profiles" 2>/dev/null; }

# 1. Token, nur falls noch keiner da ist.
if [ -z "$(get HERMES_DASHBOARD_TOKEN)" ]; then
  head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' | set_var HERMES_DASHBOARD_TOKEN
  echo "HERMES_DASHBOARD_TOKEN neu erzeugt (nicht angezeigt)"
fi

# 2. Eintrag in hosts.json (alle Hermes-Runtimes mit multiplex, also das Container-Gateway).
if [ -f "$hosts" ]; then
  python3 - "$hosts" "$port" <<'PY' || echo "hosts.json nicht angepasst: \"dashboard\": {\"base_url\": \"http://127.0.0.1:$port\", \"token_env\": \"HERMES_DASHBOARD_TOKEN\"} selbst bei der Runtime eintragen"
import json, shutil, sys
path, port = sys.argv[1], sys.argv[2]
data = json.load(open(path))
changed = False
for host in data.get("hosts", []):
    for rt in host.get("runtimes", []):
        if rt.get("id") == "hermes" and rt.get("multiplex") and "dashboard" not in rt:
            rt["dashboard"] = {"base_url": f"http://127.0.0.1:{port}", "token_env": "HERMES_DASHBOARD_TOKEN"}
            changed = True
if changed:
    shutil.copy2(path, path + ".bak")
    json.dump(data, open(path, "w"), indent=2, ensure_ascii=False)
    print("hosts.json: dashboard-Eintrag ergänzt")
PY
fi

# 3. Dashboard starten, falls es nicht schon mit diesem Token antwortet.
if profiles >/dev/null; then
  echo "Dashboard läuft bereits auf 127.0.0.1:$port"
else
  export HERMES_DASHBOARD_SESSION_TOKEN; HERMES_DASHBOARD_SESSION_TOKEN="$(get HERMES_DASHBOARD_TOKEN)"
  "${docker[@]}" exec -d -e HERMES_DASHBOARD_SESSION_TOKEN "$name" \
    sh -c "exec hermes dashboard --host 127.0.0.1 --port $port --no-open >/tmp/dashboard.log 2>&1" \
    || { echo "docker exec fehlgeschlagen (Container $name läuft?)"; exit 1; }
  unset HERMES_DASHBOARD_SESSION_TOKEN
  for _ in $(seq 1 20); do profiles >/dev/null && break; sleep 1; done
  if ! profiles >/dev/null; then
    echo "Das Dashboard antwortet nicht auf 127.0.0.1:$port. Log aus dem Container:"
    "${docker[@]}" exec "$name" tail -n 20 /tmp/dashboard.log 2>&1 | sed 's/\(secret\|key\|token\)=[^ ]*/\1=…/Ig'
    exit 1
  fi
  echo "Dashboard gestartet auf 127.0.0.1:$port"
fi
echo "Profile im Dashboard: $(profiles | grep -o '"name"' | wc -l)"
echo "Als Nächstes: bash deploy/deploy.sh   (liest Token und Config neu ein)"
