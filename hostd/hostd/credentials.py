"""Zugangsdaten: der lokale Tresor (`hermes vault`) und die Secrets-Anbieter (`hermes secrets ...`).

Hermes bietet beides nur als CLI. Hier läuft deshalb eine feste, kleine Liste von Aufrufen:
- Tresor: ein Hilfsskript im Python von Hermes (`native_python`, wie bei Ziele/Heartbeats) benutzt dessen `agent.vault_store`. Die Eingabe (auch ein Passwort)
  kommt nur über stdin, nie als Argument oder Umgebungsvariable. Gelistet wird nur der lokale Tresor (Metadaten, nie Werte); externe Manager werden nicht
  angefasst, weil sie zum Entsperren eine Rückfrage an den Nutzer brauchen.
- Secrets-Anbieter: `hermes secrets <anbieter> <aktion>` mit festen Aktionen. Ausgabe ohne Farbcodes und ohne lange Zeichenfolgen, die wie ein Schlüssel aussehen.
Beides braucht ein ausdrückliches Flag am Profil (`allow_vault`, `allow_secrets`).
"""
import json
import re
from pathlib import Path

from fastapi import HTTPException

from . import native

MARK = '@@RESULT@@'
TIMEOUT = 20
PROVIDERS = ('bitwarden', 'onepassword')
SECRET_ACTIONS = {'status', 'sync', 'disable', 'set', 'remove'}
ENV_NAME = re.compile(r'^[A-Z][A-Z0-9_]{0,99}$')
REFERENCE = re.compile(r'^op://[^\t\n\r\x00-\x1f"\'`$\\;|&<>]{1,400}$')  # Leerzeichen erlaubt (Feldnamen wie „api key“)

SCRIPT = r"""import sys, json
if sys.argv[1]:
    sys.path.insert(0, sys.argv[1])
try:
    import hermes_bootstrap
except ImportError:
    pass
req = json.loads(sys.stdin.read())

def meta(m):
    d = m.to_dict()
    keep = ('id', 'kind', 'label', 'origin', 'created_at', 'identifier', 'identifier_type', 'has_otp')
    return {k: d.get(k) for k in keep if k in d}

def main():
    from agent.vault_store import VaultError, get_vault_store, LOGIN_IDENTIFIER_TYPES, VAULT_KINDS
    store = get_vault_store()
    act = req['action']
    try:
        if act == 'list':
            where = store.key_location()
            return {'items': [meta(m) for m in store.list_items()], 'key_storage': where.get('storage')}
        if act == 'add':
            secret = dict(req['secret'])
            item = store.add_item(kind=req['kind'], label=req['label'], secret=secret, origin=req.get('origin') or None)
            return {'item': meta(item)}
        if act == 'remove':
            return {'removed': bool(store.remove_item(req['id']))}
    except VaultError as exc:
        return {'refused': str(exc)[:200]}
    return {'refused': 'unknown action'}

try:
    out = {'ok': True, 'reply': main()}
except ImportError as exc:
    out = {'ok': False, 'error': 'hermes_too_old: ' + type(exc).__name__ + ': ' + str(exc)[:200]}
except BaseException as exc:
    out = {'ok': False, 'error': type(exc).__name__ + ': ' + str(exc)[:200]}
print('@@RESULT@@' + json.dumps(out))
"""

ANSI = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]')
LONG = re.compile(r'\b[A-Za-z0-9_+/=.-]{40,}\b')
USERINFO = re.compile(r'(?i)\b([a-z][a-z0-9+.-]*://)[^/\s@]*@')


def clean(text):
    text = ANSI.sub('', str(text)).replace('\r', '')
    text = USERINFO.sub(r'\1', text)
    return LONG.sub('[redacted]', text)


def _need(settings, profile, flag):
    if native.value(profile, flag, False) is not True:
        raise HTTPException(403, 'Disabled for this profile')
    python = native.value(settings, 'native_python')
    source = native.value(settings, 'native_source') or ''
    path = native.value(profile, 'path')
    if not python or not Path(python).is_absolute() or (source and not Path(source).is_absolute()) or not path:
        raise HTTPException(501, 'Hermes client not configured (native_python)')
    return python, source, path


def vault(settings, profile, request):
    """Ruft das Tresor-Skript mit einer Anfrage (stdin). Liefert die Antwort oder wirft HTTPException."""
    python, source, path = _need(settings, profile, 'allow_vault')
    try:
        output, cut, code = native.run([python, '-c', SCRIPT, source], cwd=path, env=native.native_env(profile),
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
        message = clean(result.get('error') or '')[:200]
        if 'hermes_too_old' in message:
            raise HTTPException(426, 'Hermes too old for the vault')
        raise HTTPException(409, f'Hermes refused: {message}')
    reply = result.get('reply')
    if not isinstance(reply, dict):
        raise HTTPException(502, 'Hermes client gave no usable answer')
    if reply.get('refused'):
        raise HTTPException(422, clean(reply['refused'])[:200])
    return reply


def secrets(settings, profile, provider, action, env_var=None, reference=None):
    if native.value(profile, 'allow_secrets', False) is not True:
        raise HTTPException(403, 'Disabled for this profile')
    if provider not in PROVIDERS or action not in SECRET_ACTIONS:
        raise HTTPException(422, 'Unknown provider or action')
    extra = []
    if action in ('set', 'remove'):
        if provider != 'onepassword':
            raise HTTPException(422, 'Action not supported for this provider')
        if not env_var or not ENV_NAME.fullmatch(env_var):
            raise HTTPException(422, 'Invalid variable name')
        extra = [env_var]
        if action == 'set':
            if not reference or not REFERENCE.fullmatch(reference):
                raise HTTPException(422, 'Invalid reference')
            extra.append(reference)
    cmd = native.command(settings) + ['secrets', provider, action, *extra]
    env = native.native_env(profile)
    env.update(NO_COLOR='1', TERM='dumb', COLUMNS='200', PYTHONIOENCODING='utf-8')
    try:
        output, cut, code = native.run(cmd, cwd=native.value(profile, 'path'), env=env, timeout=30)
    except OSError:
        raise HTTPException(503, 'Native command unavailable') from None
    return {'ok': code == 0 and not cut, 'output': clean(output)[:20000], 'truncated': bool(cut)}
