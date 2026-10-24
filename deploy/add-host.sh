#!/usr/bin/env bash
# Bindet einen weiteren Hermes-Host an die WebUI an (Laptop, zweiter Server, beliebig viele). Läuft auf dem Server der WebUI:
#     bash deploy/add-host.sh <kennung> "<Anzeigename>" <adresse> [Optionen]
#       --port N              Port der Hermes-API (Standard 8642)
#       --profile NAME        Profil auf diesem Host, mehrfach möglich (Standard: default; mehrere = Multiplex-Gateway)
#       --dashboard-port N    Port des Hermes-Dashboards dort (für Anbieter, SOUL und Profile); fragt zusätzlich den Dashboard-Token
#       --home ORDNER         Zielordner der WebUI (Standard ~/hermes-webui)
# Beispiel (zweiter Rechner im VPN):  bash deploy/add-host.sh laptop "Laptop" 100.64.3.4 --dashboard-port 9119
# Ergänzt config/hosts.json um einen Eintrag (kind "remote"), fragt den API_SERVER_KEY des Hosts still ab (oder liest ihn von
# stdin, Dashboard-Token als zweite Zeile) und legt ihn als HERMES_KEY_<KENNUNG> in webui.env ab. Danach: bash deploy/deploy.sh.
# Bestehende Einträge bleiben unberührt, eine vorhandene Kennung wird nie überschrieben, nichts wird gelöscht. Einzige Ausnahme:
# steht der Host schon da, ergänzt `--dashboard-port` ein fehlendes Dashboard; ohne diese Option wird nur der Key neu gesetzt.
# Der Key lässt sich ohne Abtippen übergeben (Zeile von stdin), etwa vom Laptop aus:
#     sed -n 's/^API_SERVER_KEY=//p' ~/.hermes/.env | tail -n 1 | ssh <benutzer>@<webui-server> "bash -c 'cd ~/Hermes-WebUI && bash deploy/add-host.sh laptop Laptop 100.64.3.4'"
# Sicherungen: hosts.json.bak, webui.env.bak. Werte werden weder ausgegeben noch als Argument weitergereicht.
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit "${1:-2}"; }

[ $# -ge 3 ] || usage
id="$1"; label="$2"; addr="$3"; shift 3
port=8642; dash_port=""; home="$HOME/hermes-webui"; profiles=()
while [ $# -gt 0 ]; do
  case "$1" in
    --port) port="${2:?--port braucht eine Zahl}"; shift 2 ;;
    --profile) profiles+=("${2:?--profile braucht einen Namen}"); shift 2 ;;
    --dashboard-port) dash_port="${2:?--dashboard-port braucht eine Zahl}"; shift 2 ;;
    --home) home="${2:?--home braucht einen Ordner}"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "Unbekannte Option: $1"; usage ;;
  esac
done
[ ${#profiles[@]} -gt 0 ] || profiles=(default)

[[ "$id" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || { echo "Kennung: nur a-z, 0-9 und -, höchstens 32 Zeichen (war: $id)"; exit 2; }
[[ "$addr" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Adresse: Hostname oder IP ohne Schema und Port (war: $addr)"; exit 2; }
[[ "$port" =~ ^[0-9]{2,5}$ ]] || { echo "Port ungültig: $port"; exit 2; }
[ -z "$dash_port" ] || [[ "$dash_port" =~ ^[0-9]{2,5}$ ]] || { echo "Dashboard-Port ungültig: $dash_port"; exit 2; }
for p in "${profiles[@]}"; do [[ "$p" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]] || { echo "Profilname ungültig: $p"; exit 2; }; done

cfg="$home/config/hosts.json"; envf="$home/webui.env"
[ -f "$cfg" ] && [ -f "$envf" ] || { echo "Config oder webui.env fehlt in $home (erst deploy.sh starten)"; exit 1; }

up="$(printf '%s' "$id" | tr 'a-z-' 'A-Z_')"
key_var="HERMES_KEY_$up"; tok_var="HERMES_DASHBOARD_TOKEN_$up"

# Eintrag zuerst prüfen und anlegen; die Werte kommen erst danach dran, damit eine abgelehnte Kennung nichts hinterlässt.
export ADD_ID="$id" ADD_LABEL="$label" ADD_ADDR="$addr" ADD_PORT="$port" ADD_DASH="$dash_port" ADD_KEYVAR="$key_var" ADD_TOKVAR="$tok_var" ADD_PROFILES="${profiles[*]}"
python3 - "$cfg" <<'PY'
import json, os, shutil, sys
path = sys.argv[1]
cfg = json.load(open(path))
hosts = cfg.setdefault("hosts", [])
known = next((h for h in hosts if h.get("id") == os.environ["ADD_ID"]), None)
if known is not None:
    rt = next((r for r in known.get("runtimes", []) if r.get("id") == "hermes"), None)
    if os.environ["ADD_DASH"] and rt is not None and "dashboard" not in rt:
        rt["dashboard"] = {"base_url": f"http://{known.get('address') or os.environ['ADD_ADDR']}:{os.environ['ADD_DASH']}", "token_env": os.environ["ADD_TOKVAR"]}
        shutil.copy2(path, path + ".bak")
        with open(path + ".new", "w") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(path + ".new", path)
        print(f"hosts.json: Dashboard für {os.environ['ADD_ID']} ergänzt (Port {os.environ['ADD_DASH']}).")
        sys.exit(3)
    print(f"hosts.json: Host {os.environ['ADD_ID']} steht schon da, der Eintrag bleibt; nur der Key wird neu gesetzt.")
    sys.exit(4)
profiles = os.environ["ADD_PROFILES"].split()
runtime = {
    "id": "hermes",
    "base_url": f"http://{os.environ['ADD_ADDR']}:{os.environ['ADD_PORT']}",
    "api_key_env": os.environ["ADD_KEYVAR"],
    "multiplex": len(profiles) > 1,
    "agents": profiles,
}
if os.environ["ADD_DASH"]:
    runtime["dashboard"] = {"base_url": f"http://{os.environ['ADD_ADDR']}:{os.environ['ADD_DASH']}", "token_env": os.environ["ADD_TOKVAR"]}
hosts.append({"id": os.environ["ADD_ID"], "label": os.environ["ADD_LABEL"], "kind": "remote", "address": os.environ["ADD_ADDR"], "runtimes": [runtime]})
shutil.copy2(path, path + ".bak")
tmp = path + ".new"
with open(tmp, "w") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp, path)
print(f"hosts.json: Host {os.environ['ADD_ID']} ergänzt (Hermes auf {os.environ['ADD_ADDR']}:{os.environ['ADD_PORT']}, Profile: {', '.join(profiles)}).")
PY
status=$?
[ "$status" -eq 0 ] || [ "$status" -eq 3 ] || [ "$status" -eq 4 ] || exit 1

ask() {  # ask PROMPT  -> Wert auf stdout; am Terminal still, sonst eine Zeile von stdin
  local v
  if [ -t 0 ]; then read -rsp "$1: " v; echo >&2; else IFS= read -r v; fi
  # Leerzeichen, Zeilenende, umschließende Anführungszeichen und ein mitkopiertes "NAME=" gehören nicht zum Wert.
  v="$(printf '%s' "$v" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  v="${v#API_SERVER_KEY=}"
  case "$v" in \"*\") v="${v#\"}"; v="${v%\"}" ;; \'*\') v="${v#\'}"; v="${v%\'}" ;; esac
  printf '%s' "$v"
}
set_var() {  # set_var NAME  (Wert von stdin)
  local val; val="$(cat)"
  cp -p "$envf" "$envf.bak"
  { grep -v "^$1=" "$envf.bak"; printf '%s=%s\n' "$1" "$val"; } > "$envf.new" && chmod 600 "$envf.new" && mv "$envf.new" "$envf"
}

key=""
if [ "$status" -eq 0 ] || [ "$status" -eq 4 ]; then
  key="$(ask "API_SERVER_KEY von $label")"
  [ -n "$key" ] || { echo "Kein Key eingegeben. Der Eintrag steht in hosts.json, der Key fehlt noch ($key_var in $envf)."; exit 1; }
  printf '%s' "$key" | set_var "$key_var"
  echo "webui.env: $key_var gesetzt (Länge ${#key})."
  [ "${#key}" -ge 16 ] || echo "Hinweis: Hermes startet seinen API-Server nicht mit einem Key unter 16 Zeichen. Stimmt der Wert?"
fi
if [ -n "$dash_port" ]; then
  tok="$(ask "Dashboard-Token von $label")"
  if [ -n "$tok" ]; then printf '%s' "$tok" | set_var "$tok_var"; echo "webui.env: $tok_var gesetzt (Länge ${#tok})."
  else echo "Kein Dashboard-Token eingegeben: $tok_var fehlt noch."; fi
  unset tok
fi

if [ "$status" -eq 3 ]; then echo "Jetzt die WebUI neu starten: bash deploy/deploy.sh"; exit 0; fi

# Erreichbarkeit prüfen, ohne den Key als Argument zu übergeben (curl liest den Header von stdin).
code="$(printf 'header = "Authorization: Bearer %s"\n' "$key" | curl -sS -m 6 -o /dev/null -w '%{http_code}' -K - "http://$addr:$port/v1/capabilities" 2>/dev/null)"
unset key
case "$code" in
  200) echo "Prüfung: Hermes auf $addr:$port antwortet, der Key passt." ;;
  401|403) echo "Prüfung: Hermes auf $addr:$port antwortet, lehnt den Key aber ab. $key_var in $envf muss dem API_SERVER_KEY dort entsprechen." ;;
  000|"") echo "Prüfung: keine Verbindung zu $addr:$port. Auf dem Host: lauscht Hermes dort (API_SERVER_ENABLED=true, API_SERVER_HOST=$addr, API_SERVER_KEY mit mindestens 16 Zeichen)? Prüfen mit: ss -ltnp | grep $port" ;;
  *) echo "Prüfung: Hermes auf $addr:$port antwortet mit HTTP $code." ;;
esac
echo "Jetzt die WebUI neu starten: bash deploy/deploy.sh"
