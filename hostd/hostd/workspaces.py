"""Arbeitsordner in die hostd-Config eintragen oder auflisten. Nie ueberschreiben, nie entfernen."""
import argparse
import copy
import json
import os
import re
import sys
import tempfile
from pathlib import Path

from .config import Settings

EXISTS = 3  # Exit-Code: ID schon vorhanden (Installer behandelt das als Hinweis)


def add(config_path, identifier, path, label=None):
    config_path = Path(config_path)
    config = json.loads(config_path.read_text())
    entries = config.setdefault('workspaces', [])
    if any(entry.get('id') == identifier for entry in entries):
        raise FileExistsError(identifier)
    real = Path(path).expanduser()
    if not real.is_absolute() or not real.is_dir():
        raise ValueError('workspace must be an existing absolute directory')
    real = real.resolve(strict=True)
    if real in (Path('/'), Path.home().resolve()):
        raise ValueError('root and the home directory itself are not allowed as workspace')
    candidate = copy.deepcopy(config)
    candidate.pop('probe_overrides', None)
    candidate['workspaces'].append({'id': identifier, 'label': label or identifier, 'path': str(real)})
    Settings.from_dict(candidate)  # gleiche Pruefung wie beim Start des Dienstes
    entries.append({'id': identifier, 'label': label or identifier, 'path': str(real)})
    fd, tmp = tempfile.mkstemp(dir=config_path.parent, prefix='.config-')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(config, stream, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, config_path)
    except BaseException:
        os.unlink(tmp)
        raise
    return str(real)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Arbeitsordner der hostd-Config verwalten (add, list; kein remove)')
    parser.add_argument('command', choices=['add', 'list'])
    parser.add_argument('--config', required=True)
    parser.add_argument('--id')
    parser.add_argument('--path')
    parser.add_argument('--label')
    args = parser.parse_args(argv)
    if args.command == 'list':
        for entry in json.loads(Path(args.config).read_text()).get('workspaces', []):
            print('%s\t%s\t%s' % (entry['id'], entry.get('label', ''), entry['path']))
        return 0
    if not args.id or not args.path or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', args.id):
        print('Fehler: --id (A-Z a-z 0-9 _ -, max. 64) und --path sind Pflicht', file=sys.stderr)
        return 2
    try:
        real = add(args.config, args.id, args.path, args.label)
    except FileExistsError:
        print('Arbeitsordner "%s" existiert schon; nichts geaendert' % args.id, file=sys.stderr)
        return EXISTS
    except (ValueError, OSError) as exc:
        print('Fehler: %s' % exc, file=sys.stderr)
        return 2
    print('Arbeitsordner "%s" eingetragen: %s (hostd neu starten, damit er gilt)' % (args.id, real))
    return 0


if __name__ == '__main__':
    sys.exit(main())
