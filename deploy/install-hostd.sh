#!/usr/bin/env bash
# Install as the account that already owns the CLI logins; never with sudo.
set -euo pipefail
if [[ $(id -u) == 0 ]]; then
  printf '%s\n' 'Refusing root installation/runtime.' >&2
  exit 1
fi
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
python=$(command -v python3)
venv="${XDG_DATA_HOME:-$HOME/.local/share}/hermes-hostd/venv"
config="${XDG_CONFIG_HOME:-$HOME/.config}/hermes-hostd/config.json"
env_file="${XDG_CONFIG_HOME:-$HOME/.config}/hermes-hostd/daemon.env"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
start=yes
workspaces=()
while (($#)); do
  case "$1" in
    --python|--venv|--config|--env-file|--unit-dir)
      (($# >= 2)) || { printf '%s\n' "Missing value for $1" >&2; exit 2; }
      case "$1" in
        --python) python=$2;; --venv) venv=$2;; --config) config=$2;;
        --env-file) env_file=$2;; --unit-dir) unit_dir=$2;;
      esac
      shift 2;;
    --workspace)
      (($# >= 2)) || { printf '%s\n' "Missing value for $1" >&2; exit 2; }
      workspaces+=("$2"); shift 2;;
    --no-start) start=no; shift;;
    *) printf '%s\n' 'Options: --python ABS --venv ABS --config ABS --env-file ABS --unit-dir ABS --workspace ID=ABS[:Label] --no-start' >&2; exit 2;;
  esac
done
for path in "$python" "$venv" "$config" "$env_file" "$unit_dir"; do
  [[ "$path" == /* && "$path" != *$'\n'* && "$path" != *$'\r'* ]] || {
    printf '%s\n' 'All paths must be absolute and single-line.' >&2; exit 2;
  }
done
# --workspace ID=ABSOLUTER_PFAD[:Label] vorab pruefen (vor Venv und Installation); Label darf Doppelpunkte enthalten, der Pfad nicht.
ws_id=(); ws_path=(); ws_label=()
for spec in ${workspaces[@]+"${workspaces[@]}"}; do
  [[ "$spec" =~ ^([A-Za-z0-9_-]{1,64})=(/[^:]*)(:(.*))?$ && "$spec" != *$'\n'* ]] || {
    printf '%s\n' "Invalid --workspace (expected ID=ABSOLUTE_PATH[:Label]): $spec" >&2; exit 2; }
  real=$(realpath -e -- "${BASH_REMATCH[2]}" 2>/dev/null) && [[ -d "$real" ]] || {
    printf '%s\n' "Workspace is not an existing directory: ${BASH_REMATCH[2]}" >&2; exit 2; }
  [[ "$real" != / && "$real" != "$(realpath -e -- "$HOME")" ]] || {
    printf '%s\n' "Refusing / or the home directory itself as workspace: $real" >&2; exit 2; }
  ws_id+=("${BASH_REMATCH[1]}"); ws_path+=("$real"); ws_label+=("${BASH_REMATCH[4]:-${BASH_REMATCH[1]}}")
done
umask 077
"$python" -m venv "$venv"
"$venv/bin/python" -m pip install "$repo/hostd"
"$venv/bin/python" - "$venv" "$config" "$env_file" "$unit_dir" <<'PY'
import json
import os
from pathlib import Path
import re
import secrets
import sys
venv, config, env_file, unit_dir = map(Path, sys.argv[1:])
for path in (config, env_file):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
if not config.exists():
    with config.open('x') as stream:
        json.dump(dict(listen_host='127.0.0.1', port=8790, token_env='HERMES_HOSTD_TOKEN',
                       allowed_origins=[], clis=[], workspaces=[], profiles={}, allow_shell=False), stream, indent=2)
    config.chmod(0o600)
settings = json.loads(config.read_text())
token_env = settings.get('token_env', 'HERMES_HOSTD_TOKEN')
if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', token_env):
    raise SystemExit('Invalid token_env')
if not env_file.exists():
    with env_file.open('x') as stream:
        stream.write(token_env + '=' + secrets.token_urlsafe(48) + '\n')
# Never copy CLI credentials; this file contains only daemon service configuration.
if env_file.is_symlink() or env_file.stat().st_uid != os.getuid():
    raise SystemExit('Environment file must be a regular file owned by this user')
env_file.chmod(0o600)
unit_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
def unit_arg(value):
    if any(c in value for c in "\r\n\0"):
        raise ValueError('invalid unit argument')
    return '"' + value.replace('%', '%%').replace('\\', '\\\\').replace('"', '\\"') + '"'
def unit_path(path):
    # Simple absolute paths need no quotes; systemd treats leading quotes as part of the path.
    text = str(path).replace('%', '%%')
    if any(c in text for c in " \t\"'\\"):
        return text.replace(' ', '\\x20').replace('\t', '\\x09')
    return text
unit = '\n'.join([
    '[Unit]', 'Description=Hermes per-user native CLI daemon', 'After=network.target', '',
    '[Service]', 'Type=simple',
    'WorkingDirectory=' + unit_path(Path.home()),
    'EnvironmentFile=' + unit_path(env_file),
    'Environment=' + unit_arg('PATH=' + str(venv / 'bin') + ':' + os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin')),
    'ExecStart=' + unit_path(venv / 'bin/hermes-hostd') + ' --config ' + unit_path(config),
    'Restart=on-failure', 'RestartSec=3', 'KillMode=control-group', 'TimeoutStopSec=10',
    'UMask=0077', '', '[Install]', 'WantedBy=default.target', '',
])
(unit_dir / 'hermes-hostd.service').write_text(unit)
print('Installed user unit:', unit_dir / 'hermes-hostd.service')
print('Review CLI/workspace allowlists:', config)
print('Daemon environment file (not printed):', env_file)
PY
# Hermes-Profile erkennen und ergaenzen (bestehende Eintraege bleiben unveraendert).
"$venv/bin/python" -m hostd.discover --config "$config" --hermes-home "$HOME/.hermes"
for i in ${!ws_id[@]+"${!ws_id[@]}"}; do
  rc=0
  "$venv/bin/python" -m hostd.workspaces add --config "$config" --id "${ws_id[$i]}" --path "${ws_path[$i]}" --label "${ws_label[$i]}" || rc=$?
  ((rc == 0 || rc == 3)) || exit "$rc"
done
if [[ "$start" == yes ]]; then
  systemctl --user daemon-reload
  systemctl --user enable hermes-hostd.service
  # restart statt enable --now: ein laufender Dienst startet sonst nicht mit dem neuen Code (offene Terminals enden dabei).
  systemctl --user restart hermes-hostd.service
  systemctl --user is-active hermes-hostd.service
else
  printf '%s\n' 'Not started. Review config, then systemctl --user daemon-reload && systemctl --user enable --now hermes-hostd.service'
fi
