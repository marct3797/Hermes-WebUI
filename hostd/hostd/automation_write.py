"""Ziele, Heartbeats und Schleifen ändern: über den eigenen Gateway-Client von Hermes, nie über direkte Schreibzugriffe auf `state.db`.

Hermes ist der einzige Schreiber (der Gateway führt auch den Ziel-Prüfer aus). Die Verbindung läuft deshalb mit `hermes_cli.gateway_client`
im Python-Venv von Hermes (`native_python`, wie beim Kanban-Adapter): Sitzung per `session.resume` laden, dann `session.automation`. Ticket,
Steuer-Socket und Rahmenformat bleiben Sache von Hermes und folgen seinen Updates. hostd erlaubt nur eine feste Liste von Aufrufen und
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

SCRIPT = r"""import sys, json, asyncio
if sys.argv[1]:
    sys.path.insert(0, sys.argv[1])
try:
    import hermes_bootstrap
except ImportError:
    pass
req = json.loads(sys.argv[2])

async def main():
    from hermes_cli.gateway_client import connect_gateway
    async with connect_gateway() as client:
        snapshot = await client.rpc('session.resume', session_id=req['session_id'])
        live = snapshot.get('session_id') or snapshot.get('stored_session_id') or req['session_id']
        return await client.rpc('session.automation', session_id=live, kind=req['kind'], call=req['call'],
                                args=req['args'], kwargs=req['kwargs'])

try:
    out = {'ok': True, 'reply': asyncio.run(main())}
except BaseException as exc:
    out = {'ok': False, 'error': type(exc).__name__ + ': ' + str(exc)[:200]}
print('@@RESULT@@' + json.dumps(out))
"""


def build(kind, action, text, max_turns, interval_seconds):
    """(Aufruf, args, kwargs) für Hermes oder HTTPException 422."""
    call = CALLS.get((kind, action))
    if call is None:
        raise HTTPException(422, 'Action not supported for this kind')
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
    request = json.dumps({'session_id': session_id, 'kind': kind, 'call': call, 'args': args, 'kwargs': kwargs})
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
        raise HTTPException(409, f'Hermes refused: {message}')
    reply = result.get('reply')
    error = reply.get('error') if isinstance(reply, dict) else None
    if isinstance(error, dict):
        raise HTTPException(422, native.redact(str(error.get('message') or 'Hermes refused'))[:200])
    state = reply.get('state') if isinstance(reply, dict) else None
    return {'ok': True, 'kind': kind, 'action': action, 'status': state.get('status') if isinstance(state, dict) else 'cleared'}
