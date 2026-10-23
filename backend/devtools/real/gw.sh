#!/usr/bin/env bash
# gw.sh NAME PORT: startet ein echtes Hermes-Gateway (nur der API-Server) mit eigenem Profilordner und dem Dummy-Modell aus fakellm.py.
# Umgebung: WORK (Arbeitsordner, Standard ./.real), HERMES_BIN (Standard `hermes`), FAKE_LLM_URL (Standard http://127.0.0.1:9300/v1).
# Der Key heißt testkey-NAME-0123456789abcdef (mindestens 16 Zeichen, sonst startet der API-Server nicht).
set -u
name="${1:?Name}"; port="${2:?Port}"
work="${WORK:-$PWD/.real}"; home="$work/hhome-$name"
mkdir -p "$home"
[ -f "$home/config.yaml" ] || cat > "$home/config.yaml" <<YAML
model:
  default: fake
  provider: custom
  base_url: ${FAKE_LLM_URL:-http://127.0.0.1:9300/v1}
  api_key: fake-key
agent:
  max_turns: 4
approvals:
  mode: "off"
terminal:
  backend: local
YAML
HERMES_HOME="$home" API_SERVER_ENABLED=true API_SERVER_KEY="testkey-$name-0123456789abcdef" API_SERVER_PORT="$port" API_SERVER_HOST=127.0.0.1 HERMES_ACCEPT_HOOKS=1 \
  nohup "${HERMES_BIN:-hermes}" gateway run > "$work/gw-$name.log" 2>&1 &
echo "Gateway $name auf 127.0.0.1:$port gestartet (Log $work/gw-$name.log)"
