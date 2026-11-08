"""Profil-Distributionen installieren und aktualisieren (`hermes profile install|update`, nur CLI in Hermes).

Eine Distribution bringt SOUL, `mcp.json` (Befehle, die der Agent startet), Skills, Zeitpläne und Konfiguration mit. Das ist fremder Code mit den Rechten des Agents.
Darum gilt hier:
- Nur Quellen aus der hostd-Konfiguration (`distribution_sources`: {id, label, source}) und nur Git-URLs. Der Aufrufer nennt eine `source_id`, nie eine URL oder einen Pfad.
  Ein Update zieht aus der im Profil gespeicherten Quelle; die muss genau einer freigegebenen Quelle entsprechen (der Agent kann `distribution.yaml` im Profil beschreiben).
- Erst Vorschau (Manifest, Dateiliste, Prüfsumme über den gesamten Inhalt), dann Installieren/Aktualisieren nur mit genau dieser Prüfsumme. Der Inhalt, der kopiert wird,
  ist derselbe Klon, der geprüft wurde.
- Läuft im Python von Hermes (`native_python`, `-I`, Arbeitsverzeichnis = `native_source`), je Profil mit `allow_distributions: true`.
"""
import hashlib
import json
import re
from pathlib import Path

from fastapi import HTTPException

from . import credentials, native

MARK = '@@RESULT@@'
TIMEOUT = 150
GIT_URL = re.compile(r'^(https://[^\s/]+/[^\s]+|ssh://[^\s]+|git@[A-Za-z0-9.-]+:[^\s]+)$')

SCRIPT = r"""import sys, json, hashlib, tempfile, os
from pathlib import Path
if sys.argv[1]:
    sys.path.insert(0, sys.argv[1])
try:
    import hermes_bootstrap
except ImportError:
    pass
req = json.loads(sys.stdin.read())

class TooOld(Exception):
    pass

def digest(plan, entries):
    h = hashlib.sha256()
    manifest = plan.manifest.to_dict()
    manifest.pop('installed_at', None)
    h.update(json.dumps(manifest, sort_keys=True).encode())
    files = []
    for src, rel in entries:
        if src.is_dir():
            files += [(('/'.join(rel) + '/' + p.relative_to(src).as_posix()), p) for p in sorted(src.rglob('*')) if p.is_file()]
        else:
            files.append(('/'.join(rel), src))
    for name, p in sorted(files, key=lambda x: x[0]):
        h.update(b'\0' + name.encode() + b'\0' + hashlib.sha256(p.read_bytes()).digest())
    return h.hexdigest(), [n for n, _ in sorted(files, key=lambda x: x[0])]

def summary(plan, entries):
    d, names = digest(plan, entries)
    m = plan.manifest
    return {'name': m.name, 'version': m.version, 'description': m.description[:500], 'author': m.author[:200], 'license': m.license[:100],
            'hermes_requires': m.hermes_requires[:100], 'env_requires': [{'name': e.name[:100], 'description': e.description[:300], 'required': e.required} for e in m.env_requires][:50],
            'files': names[:300], 'file_count': len(names), 'has_mcp': any(n == 'mcp.json' for n in names), 'has_cron': bool(plan.has_cron),
            'existing': bool(plan.existing), 'digest': d}

def main():
    try:
        from hermes_cli import profile_distribution as pd
    except ImportError as exc:
        raise TooOld(str(exc)[:200])
    try:
        for attr in ('plan_install', '_owned_entries', '_copy_dist_payload', '_bootstrap_user_dirs', '_existing_profile', 'read_manifest', 'DistributionError'):
            getattr(pd, attr)
        from hermes_constants import clear_named_profile_deleted
    except (AttributeError, ImportError) as exc:
        raise TooOld(str(exc)[:200])
    act = req['action']
    source = req['source']
    name = req.get('name') or None
    with tempfile.TemporaryDirectory(prefix='hermes_dist_') as tmp:
        try:
            if act == 'update' or (act == 'preview' and req.get('profile')):
                canon, target = pd._existing_profile(req['profile'])
                current = pd.read_manifest(target)
                if current is None or not current.source:
                    return {'refused': 'not_a_distribution'}
                if current.source.strip() not in req['allowed']:
                    return {'refused': 'source_not_allowed'}
                source, name = current.source, canon
            plan = pd.plan_install(source, Path(tmp), override_name=name)
            entries = list(pd._owned_entries(plan.staged_dir, plan.manifest))
            info = summary(plan, entries)
            info['preserves_config'] = bool(plan.preserves_config)
            if act == 'preview':
                return {'preview': info}
            if info['digest'] != req.get('digest'):
                return {'refused': 'changed', 'preview': info}
            if act == 'install':
                if plan.existing and not req.get('force'):
                    return {'refused': 'exists'}
                clear_named_profile_deleted(plan.target_dir)
                pd._bootstrap_user_dirs(plan.target_dir)
                pd._copy_dist_payload(plan.staged_dir, plan.target_dir, plan.manifest, preserve_config=False)
            else:
                plan.preserves_config = not req.get('force_config')
                pd._copy_dist_payload(plan.staged_dir, plan.target_dir, plan.manifest, preserve_config=plan.preserves_config)
            now = pd.read_manifest(plan.target_dir)
            return {'done': {'name': plan.manifest.name, 'version': now.version if now else None, 'digest': info['digest']}}
        except pd.DistributionError as exc:
            return {'refused': 'hermes: ' + str(exc)[:300]}

try:
    out = {'ok': True, 'reply': main()}
except TooOld as exc:
    out = {'ok': False, 'error': 'hermes_too_old: ' + str(exc)}
except BaseException as exc:
    out = {'ok': False, 'error': type(exc).__name__ + ': ' + str(exc)[:200]}
print('@@RESULT@@' + json.dumps(out))
"""


def sources(settings):
    """Freigegebene Quellen: nur Einträge mit gültiger Git-URL."""
    out = []
    for item in native.value(settings, 'distribution_sources', []) or []:
        sid, src = native.value(item, 'id'), str(native.value(item, 'source') or '').strip()
        if isinstance(sid, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', sid) and GIT_URL.fullmatch(src):
            out.append({'id': sid, 'label': str(native.value(item, 'label') or sid)[:100], 'source': src})
    return out


def public(source):
    """Quelle ohne Zugangsdaten in der URL."""
    return {'id': source['id'], 'label': source['label'], 'source': credentials.USERINFO.sub(r'\1', source['source'])}


def listing(settings, profile):
    credentials._need(settings, profile, 'allow_distributions')
    return {'sources': [public(s) for s in sources(settings)]}


def act(settings, profile, action, source_id, name=None, profile_name=None, digest=None, force=False, force_config=False):
    python, source_dir, _ = credentials._need(settings, profile, 'allow_distributions')
    allowed = sources(settings)
    chosen = next((s for s in allowed if s['id'] == source_id), None)
    if chosen is None:
        raise HTTPException(404, 'Unknown distribution source')
    if action in ('install', 'update') and not digest:
        raise HTTPException(422, 'Preview digest required')
    if action == 'update' and not profile_name:
        raise HTTPException(422, 'Profile required')
    request = {'action': action, 'source': chosen['source'], 'name': name, 'profile': profile_name, 'digest': digest, 'force': bool(force),
               'force_config': bool(force_config), 'allowed': [s['source'] for s in allowed]}
    try:
        output, cut, code = native.run([python, '-I', '-c', SCRIPT, source_dir], cwd=source_dir, env=credentials._env(settings, profile),
                                       timeout=TIMEOUT, stdin_data=json.dumps(request).encode())
    except OSError:
        raise HTTPException(503, 'Hermes client unavailable') from None
    line = next((l for l in reversed(output.splitlines()) if l.startswith(MARK)), None)
    try:
        result = json.loads(line[len(MARK):]) if line and not cut else None
    except ValueError:
        result = None
    if not isinstance(result, dict) or code != 0:
        raise HTTPException(502, 'Hermes client gave no usable answer')
    if not result.get('ok'):
        message = credentials.clean(result.get('error') or '')[:200]
        if 'hermes_too_old' in message:
            raise HTTPException(426, 'Hermes too old for distributions')
        raise HTTPException(409, f'Hermes refused: {message}')
    reply = result.get('reply')
    if not isinstance(reply, dict):
        raise HTTPException(502, 'Hermes client gave no usable answer')
    refused = reply.get('refused')
    if refused:
        text = credentials.clean(str(refused))[:300]
        if refused == 'changed':
            raise HTTPException(409, 'Source changed since the preview')
        if refused == 'source_not_allowed':
            raise HTTPException(403, 'Recorded source is not an approved source')
        raise HTTPException(422, text)
    return reply
