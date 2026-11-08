"""Bot-Modus: andere Hermes-Gateways als Peers eintragen und ihnen Nachrichten schicken (`hermes peer ...`, nur CLI in Hermes).

Gebaut wie der Tresor (`credentials.py`): ein Hilfsskript im Python von Hermes ruft die Funktionen von `hermes_cli.subcommands.peer` direkt auf.
- Der Schlüssel eines Peers (`--key`) und die Nachricht kommen nur über stdin, nie als Argument (sonst stünden sie in `ps`).
- Zurück kommen nur Namen, Adresse, Notiz und ob ein Schlüssel gesetzt ist, nie der Schlüssel.
- Die Adresse eines Peers bekommt den Schlüssel als Bearer-Token: nur http(s), ohne Zugangsdaten in der Adresse, ohne Query und Fragment.
- Senden geht nur an bereits eingetragene Peers (`<peer>` oder `<peer>/<profil>`), asynchron über `hermes peer run`; Status und Stopp über die Lauf-Kennung.
Braucht das Flag `allow_peers` am Profil.
"""
import ipaddress
import json
import re
import threading
from urllib.parse import urlsplit

from fastapi import HTTPException

from . import native
from .credentials import ANSI, MARK, MAX_REQUEST, USERINFO, _env, _need, clean

TIMEOUT = 200  # `run` macht bis zu fünf Anfragen nacheinander, jede darf in Hermes 30 s dauern
LOCKS: dict = {}
LOCKS_GUARD = threading.Lock()
NAME = re.compile(r'^[a-z0-9][a-z0-9_-]{0,63}$')
TARGET = re.compile(r'^[a-z0-9][a-z0-9_-]{0,63}(/[A-Za-z0-9][A-Za-z0-9_-]{0,63})?$')
RUN_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$')
IDEM = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$')
MAX_MESSAGE = 12000  # höchstens 4 Bytes je Zeichen in UTF-8: bleibt unter MAX_REQUEST
CONTROL = re.compile(r'[\x00-\x1f\x7f-\x9f  ]')

SCRIPT = r"""import sys, json, io, contextlib
if sys.argv[1]:
    sys.path.insert(0, sys.argv[1])
try:
    import hermes_bootstrap
except ImportError:
    pass
req = json.loads(sys.stdin.read())

class TooOld(Exception):
    pass

def main():
    try:
        from hermes_cli.subcommands import peer as P
        for needed in ('_load_peers', '_peer_secret', 'cmd_peer'):
            getattr(P, needed)
    except (ImportError, AttributeError) as exc:
        raise TooOld(str(exc)[:200])
    try:
        # Hermes liest die .env (mit den Peer-Schlüsseln) nur beim Start seiner eigenen Programme in die Umgebung.
        from hermes_cli.env_loader import load_hermes_dotenv
        load_hermes_dotenv()
    except Exception:
        pass
    act = req['action']
    if act == 'list':
        rows = []
        for name, entry in sorted(P._load_peers().items()):
            entry = entry if isinstance(entry, dict) else {}
            rows.append({'name': name, 'url': str(entry.get('url') or ''), 'note': str(entry.get('note') or ''), 'has_key': bool(P._peer_secret(name))})
        return {'peers': rows}
    ns = type('NS', (), {})()
    ns.json = True
    ns.name = req.get('name')
    ns.url = req.get('url')
    ns.key = req.get('key') or ''
    ns.note = req.get('note') or ''
    ns.target = req.get('target')
    ns.run_id = req.get('run_id')
    ns.message = req.get('message')
    ns.idempotency_key = req.get('idempotency_key')
    ns.peer_action = {'add': 'add', 'remove': 'remove', 'run': 'run', 'status': 'status', 'stop': 'stop'}.get(act)
    if ns.peer_action is None:
        return {'refused': 'unknown action'}
    if act in ('run', 'status', 'stop'):
        peer_name = str(ns.target).split('/', 1)[0]
        if peer_name not in P._load_peers() or not P._peer_secret(peer_name):
            return {'refused': 'No such peer, or it has no key'}
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = P.cmd_peer(ns)
    result = None
    for text in reversed(out.getvalue().splitlines()):
        if text.startswith('{'):
            try:
                result = json.loads(text)
            except ValueError:
                result = None
            break
    if isinstance(result, dict):
        result = {k: (v[:12000] if isinstance(v, str) else v) for k, v in result.items() if isinstance(v, (str, int, float, bool, type(None)))}
    return {'code': int(code or 0), 'result': result, 'out': '' if result is not None else out.getvalue()[:4000], 'err': err.getvalue()[-2000:]}

try:
    out = {'ok': True, 'reply': main()}
except TooOld as exc:
    out = {'ok': False, 'error': 'hermes_too_old: ' + str(exc)}
except BaseException as exc:
    out = {'ok': False, 'error': type(exc).__name__ + ': ' + str(exc)[:200]}
print('@@RESULT@@' + json.dumps(out, ensure_ascii=False))
"""


def check_url(url):
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        raise HTTPException(422, 'Invalid peer URL') from None
    if (parts.scheme not in ('http', 'https') or not parts.hostname or parts.username is not None or parts.password is not None
            or parts.query or parts.fragment or len(url) > 200 or CONTROL.search(url) or re.search(r'[\s"\'`\\<>]', url)
            or (port is not None and not 0 < port < 65536)):
        raise HTTPException(422, 'Invalid peer URL')
    try:
        address = ipaddress.ip_address(parts.hostname.strip('[]'))
    except ValueError:
        address = None
    if address is not None and (address.is_link_local or address.is_unspecified or address.is_multicast):
        raise HTTPException(422, 'Invalid peer URL')  # u. a. der Metadaten-Dienst 169.254.169.254; Loopback und Tailnet bleiben erlaubt
    return url.rstrip('/')


def call(settings, profile, request):
    """Ruft das Peer-Skript mit einer Anfrage (stdin). Liefert die Antwort oder wirft HTTPException."""
    python, source, path = _need(settings, profile, 'allow_peers')
    data = json.dumps(request, ensure_ascii=False).encode('utf-8')
    if len(data) > MAX_REQUEST:
        raise HTTPException(422, 'Request too large')
    try:
        output, cut, code = native.run([python, '-I', '-c', SCRIPT, source], cwd=source, env={**_env(settings, profile), 'PYTHONIOENCODING': 'utf-8', 'PYTHONUTF8': '1'}, timeout=TIMEOUT, stdin_data=data)
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
            raise HTTPException(426, 'Hermes too old for bot mode peers')
        raise HTTPException(409, f'Hermes refused: {message}')
    reply = result.get('reply')
    if not isinstance(reply, dict):
        raise HTTPException(502, 'Hermes client gave no usable answer')
    if reply.get('refused'):
        raise HTTPException(422, clean(reply['refused'])[:200])
    return reply


def act(settings, profile, req):
    action = req['action']
    payload = {'action': action}
    if action == 'add':
        if not NAME.fullmatch(req.get('name') or ''):
            raise HTTPException(422, 'Invalid peer name')
        payload.update(name=req['name'], url=check_url(req.get('url') or ''), key=req.get('key') or '', note=req.get('note') or '')
        if len(payload['key']) > 500 or not payload['key'].isascii() or CONTROL.search(payload['key']) or len(payload['note']) > 200 or CONTROL.search(payload['note']):
            raise HTTPException(422, 'Invalid key or note')
    elif action == 'remove':
        if not NAME.fullmatch(req.get('name') or ''):
            raise HTTPException(422, 'Invalid peer name')
        payload['name'] = req['name']
    elif action in ('run', 'status', 'stop'):
        if not TARGET.fullmatch(req.get('target') or ''):
            raise HTTPException(422, 'Invalid peer target')
        payload['target'] = req['target']
        if action == 'run':
            message = req.get('message') or ''
            if not message.strip() or len(message) > MAX_MESSAGE:
                raise HTTPException(422, 'Invalid message')
            payload['message'] = message
            key = req.get('idempotency_key')
            if key is not None:
                if not IDEM.fullmatch(key):
                    raise HTTPException(422, 'Invalid idempotency key')
                payload['idempotency_key'] = key
        else:
            if not RUN_ID.fullmatch(req.get('run_id') or ''):
                raise HTTPException(422, 'Invalid run id')
            payload['run_id'] = req['run_id']
    elif action != 'list':
        raise HTTPException(422, 'Unknown action')
    if action in ('add', 'remove'):
        with LOCKS_GUARD:
            lock = LOCKS.setdefault(str(native.value(profile, 'path')), threading.Lock())
        if not lock.acquire(blocking=False):
            raise HTTPException(409, 'Another peer change is running')
        try:
            reply = call(settings, profile, payload)
        finally:
            lock.release()
    else:
        reply = call(settings, profile, payload)
    if action == 'list':
        return {'peers': reply.get('peers') or []}
    out = clean(reply.get('out') or '')
    result = reply.get('result') if isinstance(reply.get('result'), dict) else None
    if result is not None:
        # erst parsen, dann nur die Werte bereinigen; die Antwort des Peers ist Inhalt und wird nicht auf „schlüsselähnlich“ gekürzt
        result = {k: ((USERINFO.sub(r'\1', ANSI.sub('', v)) if k in ('output', 'error') else clean(v)) if isinstance(v, str) else v) for k, v in result.items()}
    if action in ('add', 'remove'):
        return {'ok': reply.get('code') == 0, 'result': None, 'output': '', 'error': ''}  # nichts zurückgeben, was den Schlüssel enthalten könnte
    return {'ok': reply.get('code') == 0, 'result': result,
            'output': out[:4000] if result is None else '', 'error': clean(reply.get('err') or '')[:1000]}
