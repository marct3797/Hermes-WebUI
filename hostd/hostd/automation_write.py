"""Ziele, Heartbeats und Schleifen ändern: über den eigenen Gateway-Client von Hermes, nie über direkte Schreibzugriffe auf `state.db`.

Hermes ist der einzige Schreiber (der Gateway führt auch den Ziel-Prüfer aus). Die Verbindung läuft deshalb mit `hermes_cli.gateway_client`
im Python-Venv von Hermes (`native_python`, wie beim Kanban-Adapter): Sitzung per `session.resume` laden, dann `session.automation`. Ticket,
Steuer-Socket und Rahmenformat bleiben Sache von Hermes und folgen seinen Updates. hostd startet nie einen Gateway: erst `discover_gateway_endpoint`,
dann `connect_gateway(endpoint)` (ohne Endpunkt würde Hermes selbst einen starten, auf Hikari ein zweiter neben dem im Container). Ein neues oder
fortgesetztes Ziel stößt den ersten Lauf an wie das Terminal: der Gateway speichert nur den Zustand, den ersten Prompt schickt der Client (`prompt.submit`). hostd erlaubt nur eine feste Liste von Aufrufen und
verlangt `allow_automation: true` am Profil.
"""
import json
import re
from pathlib import Path

from fastapi import HTTPException

from . import native

MARK = '@@RESULT@@'
TIMEOUT = 30
# (Art, Aktion) -> Methode des Hermes-Managers. Schleifen anlegen (`/loop`) ist bewusst nicht dabei: zu viele Parameter, nur im Terminal.
CALLS = {('goal', 'set'): 'set', ('goal', 'pause'): 'pause', ('goal', 'resume'): 'resume', ('goal', 'clear'): 'clear',
         ('heartbeat', 'set'): 'set', ('heartbeat', 'pause'): 'pause', ('heartbeat', 'resume'): 'resume', ('heartbeat', 'clear'): 'clear',
         ('loop', 'pause'): 'pause', ('loop', 'resume'): 'resume', ('loop', 'clear'): 'clear'}

SCRIPT = r"""import sys, json, asyncio, uuid, dataclasses
from pathlib import Path
if sys.argv[1]:
    sys.path.insert(0, sys.argv[1])
try:
    import hermes_bootstrap
except ImportError:
    pass
req = json.loads(sys.argv[2])

class TooOld(Exception):
    pass

async def call(client, method, **params):
    try:
        return await client.rpc(method, **params)
    except Exception as exc:
        if getattr(exc, 'code', None) == -32601 or 'unknown method' in str(exc).lower():
            raise TooOld(method)
        raise

async def main():
    from hermes_cli.gateway_client import connect_gateway
    from hermes_cli.gateway_runtime import attachable, discover_gateway_endpoint, gateway_profile_home
    from hermes_constants import get_hermes_home
    home = gateway_profile_home(get_hermes_home())
    found = discover_gateway_endpoint(home, timeout=2.0)
    if not attachable(found):
        raise RuntimeError('gateway_not_running: ' + str(getattr(found, 'state', '')) + ' ' + str(getattr(found, 'reason_code', '')))
    endpoint = found.endpoint
    if not getattr(endpoint, 'control_home', True):
        # Wie das Dashboard von Hermes: antwortet das gewählte Profil auf einem eigenen Socket (vom Multiplexer bedient), das Ticket dort prägen lassen.
        endpoint = dataclasses.replace(endpoint, control_home=str(Path(home).expanduser().resolve()))
    async with connect_gateway(endpoint) as client:
        snapshot = await call(client, 'session.resume', session_id=req['session_id'])
        live = snapshot.get('session_id') or snapshot.get('stored_session_id') or req['session_id']
        reply = await call(client, 'session.automation', session_id=live, kind=req['kind'], call=req['call'],
                                 args=req['args'], kwargs=req['kwargs'])
        kick = None
        if not reply.get('error'):
            if req.get('kick') == 'goal':
                from hermes_cli.goals import goal_kick_prompt
                kick = goal_kick_prompt(req['args'][0], '')
            elif req.get('kick') == 'prompt':
                value = reply.get('value')
                kick = value.get('prompt') if isinstance(value, dict) else None
        started = False
        if kick:
            receipt = await call(client, 'prompt.submit', session_id=live, submission_id=uuid.uuid4().hex, text=kick, queued=True)
            started = bool((receipt or {}).get('admission_id'))
        reply['started'] = started
        return reply

try:
    out = {'ok': True, 'reply': asyncio.run(main())}
except TooOld as exc:
    out = {'ok': False, 'error': 'hermes_too_old: ' + str(exc)}
except ImportError as exc:
    name = getattr(exc, 'name', '') or ''
    old = name.split('.')[0] in ('hermes_cli', 'hermes_constants', 'gateway') or 'cannot import name' in str(exc)
    out = {'ok': False, 'error': ('hermes_too_old: ' if old else '') + type(exc).__name__ + ': ' + str(exc)[:200]}
except BaseException as exc:
    out = {'ok': False, 'error': type(exc).__name__ + ': ' + str(exc)[:200]}
print('@@RESULT@@' + json.dumps(out))
"""


def build(kind, action, text, max_turns, interval_seconds):
    """(Aufruf, args, kwargs) für Hermes oder HTTPException 422."""
    call = CALLS.get((kind, action))
    if call is None:
        raise HTTPException(422, 'Action not supported for this kind')
    if kind == 'goal' and action == 'resume':
        return 'command', ['resume'], {}
    if action != 'set':
        return call, [], {}
    clean = (text or '').strip()
    if not clean:
        raise HTTPException(422, 'Text required')
    if kind == 'goal':
        return call, [clean], ({'max_turns': max_turns} if max_turns else {})
    if not interval_seconds:
        raise HTTPException(422, 'Interval required')
    return call, [clean, interval_seconds], {}


def apply(settings, profile, session_id, kind, action, text=None, max_turns=None, interval_seconds=None):
    if native.value(profile, 'allow_automation', False) is not True:
        raise HTTPException(403, 'Automation changes disabled for this profile')
    python = native.value(settings, 'native_python')
    source = native.value(settings, 'native_source') or ''
    path = native.value(profile, 'path')
    if not python or not Path(python).is_absolute() or (source and not Path(source).is_absolute()) or not path:
        raise HTTPException(501, 'Hermes client not configured (native_python)')
    call, args, kwargs = build(kind, action, text, max_turns, interval_seconds)
    kick = 'goal' if (kind, action) == ('goal', 'set') else 'prompt' if (kind, action) == ('goal', 'resume') else None
    request = json.dumps({'session_id': session_id, 'kind': kind, 'call': call, 'args': args, 'kwargs': kwargs, 'kick': kick})
    try:
        output, cut, code = native.run([python, '-c', SCRIPT, source, request], cwd=path, env=native.native_env(profile), timeout=TIMEOUT)
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
        message = native.redact(str(result.get('error') or ''))[:200]
        if 'hermes_too_old' in message:
            raise HTTPException(426, 'Hermes too old for changes')
        if 'gateway_not_running' in message:
            raise HTTPException(503, 'Hermes gateway not running for this profile')
        raise HTTPException(409, f'Hermes refused: {message}')
    reply = result.get('reply')
    error = reply.get('error') if isinstance(reply, dict) else None
    if isinstance(error, dict):
        raise HTTPException(422, native.redact(str(error.get('message') or 'Hermes refused'))[:200])
    state = reply.get('state') if isinstance(reply, dict) else None
    return {'ok': True, 'kind': kind, 'action': action, 'status': state.get('status') if isinstance(state, dict) else 'cleared',
            'started': reply.get('started') is True if kick else None}
