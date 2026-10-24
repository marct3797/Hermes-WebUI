"""Hermes-Profile des Benutzers erkennen und in die hostd-Config ergaenzen (nie ueberschreiben)."""
import argparse
import json
import re
from pathlib import Path

ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}')


def discover(hermes_home):
    root = Path(hermes_home).expanduser()
    if not root.is_dir():
        return {}
    found = {'default': {'path': str(root.resolve())}}
    profiles = root / 'profiles'
    if profiles.is_dir() and not profiles.is_symlink():
        for entry in sorted(profiles.iterdir()):
            if entry.is_dir() and not entry.is_symlink() and ID.fullmatch(entry.name) and entry.name != 'default':
                found[entry.name] = {'path': str(entry.resolve())}
    return found


def merge(config_path, hermes_home):
    """Gibt (hinzugefuegt, vorhanden) zurueck; schreibt nur, wenn etwas fehlt."""
    path = Path(config_path)
    config = json.loads(path.read_text())
    profiles = config.setdefault('profiles', {})
    if not isinstance(profiles, dict):
        raise SystemExit('profiles in der Config ist kein Objekt; nichts geaendert')
    added = [name for name in discover(hermes_home) if name not in profiles]
    for name in added:
        profiles[name] = discover(hermes_home)[name]
    if added:
        path.write_text(json.dumps(config, indent=2))
    return added, [name for name in profiles if name not in added]


def main():
    parser = argparse.ArgumentParser(description='Hermes-Profile in die hostd-Config eintragen')
    parser.add_argument('--config', required=True)
    parser.add_argument('--hermes-home', default='~/.hermes')
    args = parser.parse_args()
    if not Path(args.hermes_home).expanduser().is_dir():
        print('Profile: kein Hermes in ' + args.hermes_home + ', nichts eingetragen')
        return
    added, kept = merge(args.config, args.hermes_home)
    print('Profile: %d ergaenzt (%s), %d vorhanden' % (len(added), ', '.join(added) or '-', len(kept)))


if __name__ == '__main__':
    main()
