"""Bounded native adapters. No client-provided commands or installation URLs."""
import json
import os
from pathlib import Path
import re
import selectors
import signal
import sqlite3
import subprocess
import time
from urllib.parse import urlsplit, urlunsplit

from fastapi import HTTPException
import yaml

from .workspace import LIMIT, forbidden, opened


def value(config, name, default=None):
    return config.get(name, default) if isinstance(config, dict) else getattr(config, name, default)


def redact(text):
    def clean_url(match):
        try:
            u = urlsplit(match.group())
            host = u.hostname or ''
            if ':' in host:
                host = '[' + host + ']'
            return urlunsplit((u.scheme, host + (':' + str(u.port) if u.port else ''), u.path, '', ''))
        except ValueError:
            return '[redacted-url]'
    text = re.sub(r'[A-Za-z][A-Za-z0-9+.-]*://[^\s<>"\']+', clean_url, str(text))
    # Secret-bearing log/diff lines are omitted whole, including multiline PEMs.
    text = re.sub(r'-----BEGIN [^-]*PRIVATE KEY-----.*?(?:-----END [^-]*PRIVATE KEY-----|\Z)',
                  '[redacted-key]', text, flags=re.S)
    return '\n'.join('[redacted]' if re.search(
        r'(?i)(authorization|cookie|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|secret|token|bearer\s+|sk-[A-Za-z0-9]|eyJ[A-Za-z0-9_-]{12}|^[A-Za-z0-9+/=]{48,}$)', line)
        else line for line in text.splitlines())


def run(argv, *, cwd, env=None, timeout=8, limit=LIMIT):
    """Drain one merged pipe with hard byte/time bounds; never expose stderr."""
    environment = dict(os.environ if env is None else env)
    environment.update(PYTHONDONTWRITEBYTECODE='1', GIT_TERMINAL_PROMPT='0', GIT_OPTIONAL_LOCKS='0',
                       GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)
    # An inherited git override must not redirect a workspace read to another repository.
    for key in list(environment):
        if key.startswith('GIT_') and key not in {'GIT_TERMINAL_PROMPT', 'GIT_OPTIONAL_LOCKS',
                                                  'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'}:
            del environment[key]
    process = subprocess.Popen(argv, cwd=cwd, env=environment, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    output = bytearray()
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout
    truncated = False
    try:
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise HTTPException(504, 'Native operation timed out; result unknown')
            for key, _ in selector.select(min(remaining, 0.2)):
                chunk = os.read(key.fileobj.fileno(), min(8192, limit + 1 - len(output)))
                if not chunk:
                    selector.unregister(key.fileobj)
                else:
                    output.extend(chunk)
                if len(output) > limit:
                    truncated = True
                    return output[:limit].decode('utf-8', errors='replace'), truncated, None
        code = process.wait(timeout=max(0.01, deadline - time.monotonic()))
        return output.decode('utf-8', errors='replace'), truncated, code
    except subprocess.TimeoutExpired:
        raise HTTPException(504, 'Native operation timed out; result unknown') from None
    finally:
        selector.close()
        # Descendants must not outlive a timeout, byte cap, or closed pipe.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        process.stdout.close()


def git(root):
    root = Path(root)
    if root.is_symlink() or not (root / '.git').is_dir() or (root / '.git').is_symlink():
        return {'repository': False, 'reason': 'Kein Git-Repository in diesem Arbeitsordner'}
    prefix = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
              '-c', 'diff.external=', '-c', 'core.hooksPath=/dev/null', '--no-pager', '--literal-pathspecs']
    truncated = False
    def call(*args):
        nonlocal truncated
        try:
            text, cut, code = run(prefix + list(args), cwd=root)
        except OSError:
            raise HTTPException(503, 'Git unavailable') from None
        truncated |= cut
        if code not in (0, None):
            raise HTTPException(409, 'Git read failed')
        return text
    branch = call('branch', '--show-current').strip()
    status = redact(call('status', '--short', '--untracked-files=no'))
    # Only individually validated tracked files enter diff; secrets never enter the output pipe.
    _, cut, head_code = run(prefix + ['rev-parse', '--verify', '--quiet', 'HEAD'], cwd=root)
    truncated |= cut
    comparison = ['HEAD'] if head_code == 0 else ['--cached']
    names = call('diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', *comparison, '--').split('\x00')
    safe = []
    for name in names:
        if not name or any(forbidden(p) for p in Path(name).parts):
            continue
        try:
            with opened(root, name):
                safe.append(name)
        except HTTPException:
            continue
        if len(safe) >= 100:
            truncated = True
            break
    diff = call('diff', '--no-ext-diff', '--no-textconv', '--no-color', *comparison, '--', *safe) if safe else ''
    remotes = []
    for line in call('remote', '-v').splitlines():
        fields = line.split()
        if len(fields) >= 2 and fields[-1] == '(fetch)':
            remotes.append({'name': redact(fields[0]), 'url': redact(fields[1])})
    return {'branch': redact(branch), 'status': status, 'diff': redact(diff),
            'remotes': remotes, 'truncated': truncated}


def unavailable(reason):
    return {'available': False, 'reason': reason, 'items': [], 'actions': []}


def profile_file(profile, relative, limit=LIMIT):
    """Private config reads bypass workspace filename policy, not descriptor confinement."""
    root = Path(value(profile, 'path'))
    # These are server-fixed relative names, never client paths.
    names = relative.split('/')
    fds = []
    try:
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        fds.append(fd)
        for i, name in enumerate(names):
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK |
                         (os.O_DIRECTORY if i < len(names) - 1 else 0), dir_fd=fd)
            fds.append(fd)
        import stat
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise OSError('Not regular')
        size = os.fstat(fd).st_size
        if relative.endswith('.log') and size > limit:
            os.lseek(fd, -limit, os.SEEK_END)
        data = os.read(fd, limit + 1)
        if len(data) > limit and not relative.endswith('.log'):
            raise OSError('File too large')
        return data[:limit].decode('utf-8', errors='replace'), size > limit
    finally:
        for fd in reversed(fds):
            os.close(fd)


def native_env(profile):
    environment = dict(os.environ)
    environment['HERMES_HOME'] = str(Path(value(profile, 'path')).absolute())
    # Do not let an active parent profile/board silently override the configured target.
    for key in ('HERMES_PROFILE', 'HERMES_KANBAN_DB', 'HERMES_KANBAN_BOARD', 'HERMES_ACCEPT_HOOKS'):
        environment.pop(key, None)
    return environment


def command(settings):
    cmd = value(settings, 'hermes_command', [])
    if not isinstance(cmd, (list, tuple)) or not cmd or not Path(cmd[0]).is_absolute():
        raise HTTPException(501, 'Absolute hermes_command is not configured')
    return list(cmd)


def listing(settings, profile, kind):
    root = Path(value(profile, 'path'))
    if kind == 'logs':
        try:
            content, cut = profile_file(profile, 'logs/agent.log')
            return {'available': True, 'content': redact(content), 'truncated': cut, 'items': [], 'actions': []}
        except OSError:
            return unavailable('Native agent.log unavailable')
    if kind == 'skills':
        items = []
        cut = False
        try:
            with opened(root, 'skills') as fd:
                # fd-relative recursion keeps concurrent symlink swaps confined.
                visited = 0
                cut = False
                def walk(directory, prefix='', depth=0):
                    nonlocal visited, cut
                    if depth > 6 or len(items) >= 1000 or visited >= 5000:
                        cut = True
                        return
                    with os.scandir(directory) as entries:
                        names = []
                        for entry in entries:
                            visited += 1
                            if visited > 5000:
                                cut = True
                                break
                            if entry.name == 'SKILL.md' and entry.is_file(follow_symlinks=False):
                                items.append({'id': prefix, 'name': prefix.rsplit('/', 1)[-1]})
                                return
                            if not forbidden(entry.name) and entry.is_dir(follow_symlinks=False):
                                names.append(entry.name)
                    for name in names:
                        if visited >= 5000 or len(items) >= 1000:
                            cut = True
                            break
                        try:
                            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                        except OSError:
                            continue
                        try:
                            walk(child, '/'.join(filter(None, (prefix, name))), depth + 1)
                        finally:
                            os.close(child)
                walk(fd)
        except HTTPException as exc:
            if exc.status_code != 404:
                return unavailable('Native skills directory unavailable')
        return {'available': True, 'items': items, 'actions': [], 'scope': 'profile-local', 'truncated': cut,
                'note': 'External, project and bundled skill roots are not enumerated; interactive skill toggles unavailable'}
    if kind == 'mcp':
        try:
            text, _ = profile_file(profile, 'config.yaml', 1048576)
            config = yaml.safe_load(text) or {}
            servers = config.get('mcp_servers', {})
            if not isinstance(servers, dict):
                return unavailable('Native MCP configuration unsupported')
            items = [{'id': str(name), 'enabled': cfg.get('enabled', True) is not False}
                     for name, cfg in list(servers.items())[:1000] if isinstance(cfg, dict)]
            return {'available': True, 'items': items, 'actions': [],
                    'note': 'Native CLI has no non-interactive MCP enable/disable; installation requires native trust flow'}
        except FileNotFoundError:
            return {'available': True, 'items': [], 'actions': []}
        except (OSError, yaml.YAMLError, AttributeError):
            return unavailable('Native MCP configuration unavailable')
    if kind == 'plugins':
        try:
            output, cut, code = run(command(settings) + ['plugins', 'list', '--json'], cwd=root, env=native_env(profile))
            if code != 0 or cut:
                return unavailable('Native plugin listing failed or exceeded bound')
            rows = json.loads(output)
            if not isinstance(rows, list):
                raise ValueError
            items = [{'id': str(row['name']), 'enabled': row.get('status') == 'enabled',
                      'status': str(row.get('status', 'unknown'))} for row in rows if isinstance(row, dict)]
            return {'available': True, 'items': items, 'actions': ['enable', 'disable', 'install']
                    if value(profile, 'allow_management', False) else []}
        except (HTTPException, OSError, ValueError, KeyError):
            return unavailable('Native plugin CLI unavailable or incompatible')
    if kind == 'kanban':
        python = value(settings, 'native_python')
        source = value(settings, 'native_source')
        database = value(profile, 'kanban_db')
        if not python or not source or not database or not all(Path(p).is_absolute() for p in (python, source, database)):
            return unavailable('Native read-only Kanban adapter not configured (native_python, native_source, profile.kanban_db)')
        # CLI list recomputes task states. Call the native read function on a mode=ro connection instead.
        script = """import sys,json,sqlite3
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import hermes_bootstrap
from hermes_cli.kanban_db import list_tasks
c=sqlite3.connect(Path(sys.argv[2]).as_uri()+'?mode=ro',uri=True,timeout=1)
c.row_factory=sqlite3.Row
c.execute('PRAGMA query_only=ON')
c.set_progress_handler(lambda: 1 if __import__('time').monotonic()>deadline else 0,1000)
deadline=__import__('time').monotonic()+2
rows=list_tasks(c,limit=201)
print(json.dumps([dict(id=t.id,title=t.title,status=t.status,assignee=t.assignee,priority=t.priority) for t in rows]))
c.close()
"""
        try:
            text, cut, code = run([python, '-c', script, source, database], cwd=root, env=native_env(profile))
            rows = json.loads(text) if code == 0 and not cut else None
            if not isinstance(rows, list):
                return unavailable('Existing native Kanban board unavailable or incompatible')
            for row in rows[:200]:
                for key, text in row.items():
                    if isinstance(text, str):
                        row[key] = redact(text)
            return {'available': True, 'items': rows[:200],
                    'truncated': len(rows) > 200, 'actions': []}
        except (OSError, ValueError, HTTPException):
            return unavailable('Native read-only Kanban adapter failed')
    raise HTTPException(404, 'Unknown management kind')


def act(settings, profile, kind, action, identifier):
    if not value(profile, 'allow_management', False):
        raise HTTPException(403, 'Profile management disabled')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,100}', identifier):
        raise HTTPException(403, 'Only catalog identifiers accepted')
    if kind != 'plugins' or action not in ('enable', 'disable', 'install'):
        raise HTTPException(501, 'Native non-interactive action unavailable; use native trust flow')
    allowed = value(profile, 'allowed_plugins', [])
    if identifier not in allowed:
        raise HTTPException(403, 'Plugin not reviewed for this profile')
    before = listing(settings, profile, kind)
    if not before['available']:
        raise HTTPException(503, 'Native plugin inventory unavailable')
    installed = {item['id']: item for item in before['items']}
    args = ['plugins', action, identifier]
    if action == 'install':
        catalog = value(settings, 'reviewed_catalog', [])
        entry = next((item for item in catalog if value(item, 'id') == identifier
                      and value(item, 'kind') == kind and value(item, 'reviewed') is True), None)
        if entry is None:
            raise HTTPException(403, 'Plugin not in configured reviewed catalog')
        if identifier in installed:
            raise HTTPException(409, 'Plugin already installed')
        args += ['--no-deps', '--no-enable']
    elif identifier not in installed:
        raise HTTPException(404, 'Plugin not installed')
    elif action == 'enable':
        args += ['--no-allow-tool-override']
    try:
        _, cut, code = run(command(settings) + args, cwd=value(profile, 'path'), env=native_env(profile), timeout=30)
    except OSError:
        raise HTTPException(503, 'Native plugin command unavailable') from None
    if code != 0 or cut:
        raise HTTPException(409, 'Native command refused, failed, or needs interactive consent; inspect native CLI')
    after = listing(settings, profile, kind)
    item = next((i for i in after['items'] if i['id'] == identifier), None)
    expected = action == 'enable'
    if not after['available'] or item is None or item['enabled'] != expected:
        raise HTTPException(409, 'Native result could not be verified')
    return {'ok': True, 'id': identifier, 'action': action, 'item': item}
