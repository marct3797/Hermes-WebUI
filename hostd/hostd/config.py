"""Explicit per-user configuration; never discovers account credentials."""
import ipaddress
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit


EXITED_TTL_S = 600  # beendete Terminals bleiben so lange in der Liste (Replay inklusive)


@dataclass
class Settings:
    listen_host: str = '127.0.0.1'
    port: int = 8790
    token_env: str = 'HERMES_HOSTD_TOKEN'
    allowed_origins: list = field(default_factory=list)
    clis: list = field(default_factory=list)
    workspaces: list = field(default_factory=list)
    profiles: dict = field(default_factory=dict)
    allow_shell: bool = False
    max_terminals: int = 8
    exited_ttl_s: int = EXITED_TTL_S
    probe_overrides: dict = field(default_factory=dict)  # nur Tests: ID -> argv; load() ignoriert es

    @classmethod
    def from_dict(cls, value):
        settings = cls(**value)
        address = ipaddress.ip_address(settings.listen_host)
        if not (address.is_loopback or address in ipaddress.ip_network('10.0.0.0/8') or
                address in ipaddress.ip_network('172.16.0.0/12') or
                address in ipaddress.ip_network('192.168.0.0/16') or
                address in ipaddress.ip_network('100.64.0.0/10') or
                address in ipaddress.ip_network('fc00::/7')):
            raise ValueError('listen_host must be an explicit loopback or private address')
        if type(settings.port) is not int or not 1 <= settings.port <= 65535:
            raise ValueError('invalid port')
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', settings.token_env):
            raise ValueError('invalid token_env')
        if settings.allow_shell is not False:
            raise ValueError('shell command mode is not supported')
        if type(settings.max_terminals) is not int or not 1 <= settings.max_terminals <= 64:
            raise ValueError('invalid max_terminals')
        if type(settings.exited_ttl_s) is not int or not 0 <= settings.exited_ttl_s <= 86400:
            raise ValueError('invalid exited_ttl_s')
        for origin in settings.allowed_origins:
            parsed = urlsplit(origin)
            if (parsed.scheme not in ('http', 'https') or not parsed.netloc or
                    parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment or '*' in origin):
                raise ValueError('origins must be exact HTTP(S) origins')
        for entries in (settings.clis, settings.workspaces):
            seen = set()
            for entry in entries:
                identifier = entry.get('id', '')
                if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', identifier) or identifier in seen:
                    raise ValueError('invalid or duplicate configured ID')
                seen.add(identifier)
                if not isinstance(entry.get('label'), str):
                    raise ValueError('label required')
        for cli in settings.clis:
            command = cli.get('command')
            if not isinstance(command, list) or not command or any(not isinstance(arg, str) or not arg or '\0' in arg for arg in command):
                raise ValueError('CLI command must be a fixed argv list')
        for workspace in settings.workspaces:
            path = Path(workspace['path']).expanduser()
            if not path.is_absolute() or not path.is_dir():
                raise ValueError('workspace must be an existing absolute directory')
            workspace['path'] = str(path.resolve(strict=True))
        return settings

    @classmethod
    def load(cls, path):
        value = json.loads(Path(path).read_text())
        value.pop('probe_overrides', None)  # Config darf keine Statusbefehle setzen
        return cls.from_dict(value)

    def token(self):
        token = os.environ.get(self.token_env, '')
        if len(token) < 32 or not token.isascii() or any(c.isspace() for c in token):
            raise ValueError('a non-whitespace ASCII bearer token of at least 32 characters is required')
        return token

    def workspace_path(self, identifier):
        workspace = next((item for item in self.workspaces if item['id'] == identifier), None)
        if workspace is None:
            raise ValueError('unknown workspace')
        path = Path(workspace['path'])
        if not path.is_dir() or str(path.resolve(strict=True)) != workspace['path']:
            raise ValueError('configured workspace changed or escaped its real path')
        return path
