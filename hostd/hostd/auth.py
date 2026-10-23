"""Anmeldestatus der CLIs ueber feste Statusbefehle (kein Modelllauf). Die Befehle kommen nie aus der Config."""
import asyncio
import json
import os
import re
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

TTL, MIN_REFRESH, TIMEOUT, MAX_OUTPUT = 60, 10, 15, 65536
ANSI = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]')

# CLI-ID -> feste Argumente; die ausfuehrbare Datei ist die konfigurierte (gleiche wie im Terminal).
PROBES = {
    'codex': ['login', 'status'],
    'claude': ['auth', 'status'], 'claude-code': ['auth', 'status'],
    'opencode': ['auth', 'list'],
    'agy': ['models'], 'antigravity': ['models'],
}


def _result(state, method=None, reason=None):
    return state, method, reason


def parse_codex(code, text):
    if 'not logged in' in text.lower() or code != 0:
        return _result('signed_out')
    match = re.search(r'logged in using (.{1,40})', text, re.I)
    if code == 0 and match:
        return _result('signed_in', 'API-Key' if 'key' in match.group(1).lower() else 'ChatGPT')
    return _result('unknown', reason='Unerwartete Ausgabe')


def parse_claude(code, text):
    try:
        data = json.loads(text)
        logged = data['loggedIn']
    except (ValueError, KeyError, TypeError):
        return _result('unknown', reason='Unerwartete Ausgabe')
    if logged is True:
        method = data.get('authMethod')
        return _result('signed_in', method[:40] if isinstance(method, str) else None)
    return _result('signed_out') if logged is False else _result('unknown', reason='Unerwartete Ausgabe')


def parse_opencode(code, text):
    creds = re.search(r'(\d+) credentials?', text)
    envs = re.search(r'(\d+) environment variables?', text)
    if code != 0 or not creds:
        return _result('unknown', reason='Unerwartete Ausgabe')
    if int(creds.group(1)) >= 1:
        return _result('signed_in', 'Zugangsdaten')
    if envs and int(envs.group(1)) >= 1:
        return _result('signed_in', 'Umgebungsvariable')
    return _result('signed_out')


def parse_agy(code, text):
    token = Path.home() / '.gemini/antigravity-cli/antigravity-oauth-token'
    if code == 0 and any('\t' in line for line in text.splitlines()):
        return _result('signed_in', 'OAuth' if token.exists() else 'Konto')
    if not token.exists():
        return _result('signed_out')
    return _result('unknown', reason='Modellliste nicht abrufbar')


PARSERS = {'codex': parse_codex, 'claude': parse_claude, 'claude-code': parse_claude, 'opencode': parse_opencode,
           'agy': parse_agy, 'antigravity': parse_agy}


async def run_probe(argv, env):
    process = await asyncio.create_subprocess_exec(*argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                                                   stderr=asyncio.subprocess.STDOUT, env=env, start_new_session=True)
    try:
        out, _ = await asyncio.wait_for(process.communicate(), TIMEOUT)
    except asyncio.TimeoutError:
        try:
            os.killpg(process.pid, 9)
        except OSError:
            pass
        await process.wait()
        raise
    return process.returncode, ANSI.sub('', out[:MAX_OUTPUT].decode('utf-8', 'replace'))


class AuthChecker:
    def __init__(self, settings):
        self.settings = settings
        self.cache = {}   # id -> (monotonic, entry)
        self.locks = {}

    def _argv(self, cli):
        override = getattr(self.settings, 'probe_overrides', {}).get(cli['id'])
        if override:
            return list(override)
        executable = shutil.which(cli['command'][0])
        return [executable, *PROBES[cli['id']]] if executable else None

    async def _check(self, cli):
        now = datetime.now(timezone.utc).isoformat(timespec='seconds')
        entry = dict(id=cli['id'], state='unknown', method=None, checked_at=now, reason=None)
        if cli['id'] not in PROBES and cli['id'] not in getattr(self.settings, 'probe_overrides', {}):
            entry['reason'] = 'Kein Statusbefehl bekannt'
            return entry
        argv = self._argv(cli)
        if argv is None:
            entry['reason'] = 'CLI nicht installiert'
            return entry
        env = dict(os.environ, TERM='dumb', NO_COLOR='1')
        env.pop(self.settings.token_env, None)
        try:
            code, text = await run_probe(argv, env)
            entry['state'], entry['method'], entry['reason'] = PARSERS[cli['id']](code, text)
        except asyncio.TimeoutError:
            entry['reason'] = 'Zeitueberschreitung (15 s)'
        except OSError:
            entry['reason'] = 'Statusbefehl nicht ausfuehrbar'
        return entry

    async def one(self, cli, refresh=False):
        key = cli['id']
        async with self.locks.setdefault(key, asyncio.Lock()):
            cached = self.cache.get(key)
            age = time.monotonic() - cached[0] if cached else None
            if cached and age < (MIN_REFRESH if refresh else TTL):
                return cached[1]
            entry = await self._check(cli)
            self.cache[key] = (time.monotonic(), entry)
            return entry

    async def all(self, refresh=False):
        return await asyncio.gather(*(self.one(cli, refresh) for cli in self.settings.clis))

    def cached_state(self, cli_id):
        """Nicht blockierend fuer /v1/info: None, solange nicht geprueft oder unklar."""
        cached = self.cache.get(cli_id)
        return {'signed_in': True, 'signed_out': False}.get(cached[1]['state']) if cached else None
