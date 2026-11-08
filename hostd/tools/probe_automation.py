#!/usr/bin/env python3
"""Probe für Ziele/Heartbeats: führt denselben Helfer wie hostd aus (`SCRIPT` aus hostd/automation_write.py), ohne hostd und ohne Abhängigkeiten.

Standard ist nur LESEN (`goal state`): prüft, dass der Gateway läuft, das Ticket klappt und Hermes `session.automation` kennt.
`--set TEXT` setzt ein Ziel und stößt den ersten Lauf an (ändert die Sitzung!).

  python3 probe_automation.py --python /pfad/zum/hermes/venv/bin/python --home ~/.hermes --session SITZUNGS_ID [--source /pfad/zum/hermes-agent] [--set "Test-Ziel"]
"""
import argparse
import ast
import json
import os
import subprocess
import sys
from pathlib import Path

MARK = '@@RESULT@@'


def load_script():
    source = (Path(__file__).resolve().parent.parent / 'hostd' / 'automation_write.py').read_text()
    for node in ast.parse(source).body:
        if isinstance(node, ast.Assign) and any(getattr(t, 'id', '') == 'SCRIPT' for t in node.targets):
            return ast.literal_eval(node.value)
    sys.exit('SCRIPT nicht gefunden')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--python', required=True)
    ap.add_argument('--home', required=True)
    ap.add_argument('--session', required=True)
    ap.add_argument('--source', default='')
    ap.add_argument('--set', dest='text')
    args = ap.parse_args()
    if args.text:
        req = {'session_id': args.session, 'kind': 'goal', 'call': 'set', 'args': [args.text], 'kwargs': {}, 'kick': 'goal'}
    else:
        req = {'session_id': args.session, 'kind': 'goal', 'call': 'state', 'args': [], 'kwargs': {}, 'kick': None}
    env = dict(os.environ, HERMES_HOME=str(Path(args.home).expanduser().absolute()))
    for key in ('HERMES_PROFILE', 'HERMES_KANBAN_DB', 'HERMES_KANBAN_BOARD'):
        env.pop(key, None)
    done = subprocess.run([args.python, '-c', load_script(), args.source, json.dumps(req)], env=env, capture_output=True, text=True, timeout=60)
    line = next((l for l in reversed(done.stdout.splitlines()) if l.startswith(MARK)), None)
    if not line:
        print('Keine Antwort vom Helfer. Ausgabe:\n' + done.stdout[-800:] + done.stderr[-800:])
        return 2
    result = json.loads(line[len(MARK):])
    print(json.dumps(result, indent=1, ensure_ascii=False)[:3000])
    return 0 if result.get('ok') and not (result.get('reply') or {}).get('error') else 1


if __name__ == '__main__':
    sys.exit(main())
