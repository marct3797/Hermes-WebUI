#!/usr/bin/env bash
# Richtet das Hermes-Dashboard-Plugin `ai-usage-tracker` ein (Restkontingente in der WebUI). Ohne --apply nur Ausgabe (Trockenlauf):
#     bash deploy/install-quota-plugin.sh local|docker --source ORDNER [Optionen] [--apply]
#       local    Host mit eigenem ~/.hermes: Verknüpfung (oder --copy: Kopie) nach <home>/plugins/ai-usage-tracker, dann je Profil aktivieren
#       docker   Dashboard im Container: `docker cp` nach <home>/plugins/ai-usage-tracker, chown, Container neu starten
#       --source ORDNER     Quelle des Plugins (Pflicht), z. B. ~/.hermes/plugins/ai-usage-tracker; das Plugin liegt nicht im Repo
#       --profile NAME      Profil zum Aktivieren, mehrfach möglich (Standard: default)
#       --home ORDNER       HERMES_HOME (local: ~/.hermes; docker: /opt/data, Pfad im Container)
#       --container NAME    Name des Hermes-Containers (docker; Pflicht, steht nicht im Repo: docker ps)
#       --owner UID:GID     Besitzer der Dateien im Container (docker; Pflicht: ls -ln <home> im Container zeigt ihn)
#       --copy              (local) kopieren statt verknüpfen
#       --apply             Befehle wirklich ausführen
# Es wird nichts gelöscht; ein bereits vorhandenes Ziel bricht ab. Danach das Dashboard neu starten (docker: erledigt der Block).
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit "${1:-2}"; }

[ $# -ge 1 ] || usage
target="$1"; shift
src=""; profiles=(); home=""; container=""; owner=""; copy=0; apply=0
while [ $# -gt 0 ]; do
  case "$1" in
    --source) src="${2:?--source braucht einen Ordner}"; shift 2 ;;
    --profile) profiles+=("${2:?--profile braucht einen Namen}"); shift 2 ;;
    --home) home="${2:?--home braucht einen Ordner}"; shift 2 ;;
    --container) container="${2:?--container braucht einen Namen}"; shift 2 ;;
    --owner) owner="${2:?--owner braucht UID:GID}"; shift 2 ;;
    --copy) copy=1; shift ;;
    --apply) apply=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "Unbekannte Option: $1" >&2; usage ;;
  esac
done
[ "$target" = local ] || [ "$target" = docker ] || { echo "Ziel muss local oder docker sein" >&2; usage; }
[ -n "$src" ] || { echo "--source fehlt" >&2; usage; }
[ ${#profiles[@]} -gt 0 ] || profiles=(default)
safe='^[A-Za-z0-9][A-Za-z0-9_.-]*$'
for p in "${profiles[@]}"; do [[ "$p" =~ $safe ]] || { echo "Ungültiger Profilname: $p" >&2; exit 2; }; done
if [ "$target" = docker ]; then
  [[ "$container" =~ $safe ]] || { echo "--container fehlt oder ist ungültig" >&2; exit 2; }
  [[ "$owner" =~ ^[0-9]+:[0-9]+$ ]] || { echo "--owner fehlt oder ist nicht UID:GID" >&2; exit 2; }
fi
[ -f "$src/plugin.yaml" ] || { echo "In $src liegt keine plugin.yaml: falscher Quellordner?" >&2; exit 1; }
src="$(cd "$src" && pwd)"

cmds=()
if [ "$target" = local ]; then
  home="${home:-$HOME/.hermes}"
  dest="$home/plugins/ai-usage-tracker"
  [ ! -e "$dest" ] && [ ! -L "$dest" ] || { echo "Ziel existiert schon: $dest (nichts geändert)" >&2; exit 1; }
  cmds+=("mkdir -p $(printf %q "$home/plugins")")
  if [ "$copy" = 1 ]; then cmds+=("cp -r $(printf %q "$src") $(printf %q "$dest")"); else cmds+=("ln -s $(printf %q "$src") $(printf %q "$dest")"); fi
  for p in "${profiles[@]}"; do
    if [ "$p" = default ]; then cmds+=("hermes plugins enable ai-usage-tracker"); else cmds+=("hermes -p $p plugins enable ai-usage-tracker"); fi
  done
  note="Danach das Dashboard neu starten (z. B. systemctl --user restart hermes-dashboard)."
else
  home="${home:-/opt/data}"
  dest="$home/plugins/ai-usage-tracker"
  cmds+=("docker exec $container mkdir -p $(printf %q "$home/plugins")"
         "docker cp $(printf %q "$src") $container:$dest"
         "docker exec -u 0 $container chown -R $owner $(printf %q "$dest")")
  for p in "${profiles[@]}"; do
    if [ "$p" = default ]; then cmds+=("docker exec $container hermes plugins enable ai-usage-tracker"); else cmds+=("docker exec $container hermes -p $p plugins enable ai-usage-tracker"); fi
  done
  cmds+=("docker restart $container")
  note="Existiert $dest schon, legt docker cp die Kopie darin als Unterordner an: vorher prüfen mit docker exec $container ls $dest"
fi

if [ "$apply" = 0 ]; then
  echo "# Trockenlauf, nichts ausgeführt. Mit --apply laufen diese Befehle:"
  printf '%s\n' "${cmds[@]}"
  echo "# $note"
  exit 0
fi
for c in "${cmds[@]}"; do echo "+ $c"; eval "$c" || { echo "Abbruch bei: $c" >&2; exit 1; }; done
echo "Fertig. $note"
