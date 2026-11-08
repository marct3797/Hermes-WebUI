"""Operations router; mount inside the daemon's bearer/origin boundary."""
import hashlib
import os
import re
import stat
from contextlib import contextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

from . import workspace as files
from . import memory_files as memfiles
from . import automation, automation_write, credentials, distributions, native, peers, sessions

router = APIRouter(prefix='/v1')


def value(config, name, default=None):
    return config.get(name, default) if isinstance(config, dict) else getattr(config, name, default)


def configured(settings, kind):
    entries = value(settings, kind, []) or []
    if isinstance(entries, dict):
        return [dict(id=key, **({'path': item} if isinstance(item, str) else item)) for key, item in entries.items()]
    return entries


def selected(settings, kind, identifier):
    for item in configured(settings, kind):
        if value(item, 'id') == identifier:
            return item
    raise HTTPException(404, 'Unknown ' + kind)


def workspace_root(request, identifier):
    return value(selected(request.app.state.settings, 'workspaces', identifier), 'path')


class Upload(BaseModel):
    model_config = ConfigDict(extra='forbid')
    workspace: str = Field(max_length=128)
    path: str = Field(max_length=2048)
    content_base64: str = Field(max_length=1398104)


class Mkdir(BaseModel):
    model_config = ConfigDict(extra='forbid')
    workspace: str = Field(max_length=128)
    path: str = Field(min_length=1, max_length=2048)


class Write(Mkdir):
    content: str = Field(max_length=files.UPLOAD_LIMIT)
    expected_sha256: str | None = Field(None, pattern=r'^[0-9a-f]{64}$')
    create: bool = False


class Move(BaseModel):
    model_config = ConfigDict(extra='forbid')
    workspace: str = Field(max_length=128)
    source: str = Field(min_length=1, max_length=2048, alias='from')
    target: str = Field(min_length=1, max_length=2048, alias='to')


@router.get('/workspaces')
def workspaces(request: Request):
    def is_git(w):
        git_dir = Path(value(w, 'path', '')) / '.git'
        return git_dir.is_dir() and not git_dir.is_symlink()
    return {'workspaces': [{'id': value(w, 'id'), 'label': value(w, 'label', value(w, 'id')), 'is_git': is_git(w)}
                           for w in configured(request.app.state.settings, 'workspaces')]}


@router.get('/files')
def browse(request: Request, workspace: str, path: str = Query('', max_length=2048), full: bool = False):
    return files.browse(workspace_root(request, workspace), workspace, path, full)


@router.post('/files/mkdir')
def mkdir(request: Request, body: Mkdir):
    return files.mkdir(workspace_root(request, body.workspace), body.path)


@router.put('/files/write')
def write(request: Request, body: Write):
    return files.write(workspace_root(request, body.workspace), body.path, body.content, body.expected_sha256, body.create)


@router.post('/files/move')
def move(request: Request, body: Move):
    return files.move(workspace_root(request, body.workspace), body.source, body.target)


@router.get('/files/download')
def download(request: Request, workspace: str, path: str = Query(max_length=2048)):
    data = files.download(workspace_root(request, workspace), path)
    return Response(data, media_type='application/octet-stream', headers={
        'Content-Disposition': "attachment; filename*=UTF-8''" + quote(Path(path).name, safe=''),
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store'})


@router.post('/files/upload')
def upload(request: Request, body: Upload):
    return files.upload(workspace_root(request, body.workspace), body.path, body.content_base64)


@router.get('/git')
def git(request: Request, workspace: str, mode: Literal['all', 'diff', 'staged', 'log'] = 'all', n: int = Query(1, ge=1, le=10)):
    return native.git(workspace_root(request, workspace), mode, n)


@router.get('/search')
def search(request: Request, q: str = Query(min_length=1, max_length=200)):
    return sessions.search(configured(request.app.state.settings, 'profiles'), q)


@router.get('/manage')
def manage(request: Request):
    settings = request.app.state.settings
    sources = []
    for entry in value(settings, 'reviewed_catalog', []) or []:
        if value(entry, 'reviewed') is True:
            sources.append({'id': value(entry, 'id'), 'kind': value(entry, 'kind'),
                            'url': native.redact(value(entry, 'url', '')),
                            'reviewed': True, 'trust': 'Native consent required; plugin installs remain disabled without dependencies'})
    return {'profiles': [{'id': value(p, 'id')} for p in configured(settings, 'profiles')],
            'clis': [{'id': value(c, 'id'), 'label': value(c, 'label', value(c, 'id'))}
                     for c in configured(settings, 'clis')], 'sources': sources}


@router.get('/manage/{profile}/{kind}')
def management(request: Request, profile: str, kind: str):
    settings = request.app.state.settings
    return native.listing(settings, selected(settings, 'profiles', profile), kind)


class Action(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str = Field(min_length=1, max_length=128)


class MemoryWrite(BaseModel):
    model_config = ConfigDict(extra='forbid')
    content: str = Field(max_length=1100000)
    expected_sha256: str = Field(pattern=r'^[0-9a-f]{64}$')


@router.get('/profiles/{profile}/automation')
def automation_list(profile: str, request: Request):
    return automation.read(memfiles.profile_root(request.app.state.settings, profile))


class AutomationAct(BaseModel):
    model_config = ConfigDict(extra='forbid')
    session_id: str = Field(pattern=r'^[A-Za-z0-9_.:-]{1,128}$')
    kind: Literal['goal', 'heartbeat', 'loop']
    action: Literal['set', 'pause', 'resume', 'clear']
    text: str | None = Field(default=None, max_length=2000)
    max_turns: int | None = Field(default=None, ge=1, le=1000)
    interval_seconds: int | None = Field(default=None, ge=1, le=604800)


@router.post('/profiles/{profile}/automation')
def automation_change(profile: str, body: AutomationAct, request: Request):
    settings = request.app.state.settings
    memfiles.profile_root(settings, profile)
    entry = selected(settings, 'profiles', profile)
    return automation_write.apply(settings, entry, body.session_id, body.kind, body.action, body.text, body.max_turns, body.interval_seconds)


@router.get('/profiles/{profile}/memory-files')
def memory_list(profile: str, request: Request):
    root = memfiles.profile_root(request.app.state.settings, profile)
    with memfiles.memdir(root) as sub:
        out = []
        for name in memfiles.NAMES:
            info = memfiles.stat_entry(sub, name) if sub is not None else None
            out.append({'name': name, 'size': info.st_size if info else 0,
                        'mtime': info.st_mtime if info else 0.0, 'exists': info is not None})
    return {'files': out}


@router.get('/profiles/{profile}/memory-files/{name}')
def memory_read(profile: str, name: str, request: Request):
    if name not in memfiles.NAMES:
        raise HTTPException(404, 'Unknown memory file')
    root = memfiles.profile_root(request.app.state.settings, profile)
    with memfiles.memdir(root) as sub:
        return memfiles.read_one(sub, name)


@router.put('/profiles/{profile}/memory-files/{name}')
def memory_write(profile: str, name: str, body: MemoryWrite, request: Request):
    if name not in memfiles.NAMES:
        raise HTTPException(404, 'Unknown memory file')
    if '\x00' in body.content:
        raise HTTPException(422, 'NUL byte denied')
    data = body.content.encode('utf-8')
    if len(data) > memfiles.LIMIT:
        raise HTTPException(422, 'Content too large')
    root = memfiles.profile_root(request.app.state.settings, profile)
    with memfiles.memdir(root) as sub:
        if sub is None:
            if body.expected_sha256 != memfiles.EMPTY_SHA:
                raise HTTPException(409, memfiles.CHANGED)
            from pathlib import Path as _Path
            target = _Path(root) / 'memories'
            try:
                target.mkdir(mode=0o700)
            except FileExistsError:
                pass
            except OSError:
                raise HTTPException(403, 'File operation denied') from None
            try:
                dirfd = os.open(target, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            except OSError:
                raise HTTPException(403, 'File operation denied') from None
            try:
                return _memory_store(dirfd, name, data, body.expected_sha256, existed=False)
            finally:
                os.close(dirfd)
        info = memfiles.stat_entry(sub, name)
        if info is None:
            if body.expected_sha256 != memfiles.EMPTY_SHA:
                raise HTTPException(409, memfiles.CHANGED)
            return _memory_store(sub, name, data, body.expected_sha256, existed=False)
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=sub)
        try:
            if memfiles.digest_of(fd) != body.expected_sha256:
                raise HTTPException(409, memfiles.CHANGED)
        finally:
            os.close(fd)
        return _memory_store(sub, name, data, body.expected_sha256, existed=True,
                             mode=stat.S_IMODE(info.st_mode))


def _memory_store(sub, name, data, expected, *, existed, mode=0o600):
    import secrets
    backup = False
    if existed:
        stamp = memfiles.stamp()
        try:
            os.link(name, name + '.bak-' + stamp, src_dir_fd=sub, dst_dir_fd=sub, follow_symlinks=False)
        except OSError:
            raise HTTPException(403, 'File operation denied') from None
        backup = True
        memfiles.prune_backups(sub, name)
    tmp = '.hostd-tmp-' + secrets.token_hex(8)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=sub)
    try:
        os.fchmod(fd, mode)
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
        os.fsync(fd)
        if existed:  # zweite Pruefung kurz vor dem Tausch
            check = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=sub)
            try:
                if memfiles.digest_of(check) != expected:
                    raise HTTPException(409, memfiles.CHANGED)
            finally:
                os.close(check)
        os.rename(tmp, name, src_dir_fd=sub, dst_dir_fd=sub)
        tmp = None
    finally:
        os.close(fd)
        if tmp:
            try:
                os.unlink(tmp, dir_fd=sub)
            except OSError:
                pass
    written = memfiles.read_one(sub, name)
    if written['sha256'] != hashlib.sha256(data).hexdigest():
        raise HTTPException(500, 'Write verification failed')
    return {'name': name, 'sha256': written['sha256'], 'size': written['size'],
            'mtime': written['mtime'], 'backup': backup}


@router.post('/manage/{profile}/{kind}/{action}')
def management_action(request: Request, profile: str, kind: str, action: str, body: Action):
    settings = request.app.state.settings
    return native.act(settings, selected(settings, 'profiles', profile), kind, action, body.id)


VAULT_FIELDS = ('identifier_type', 'identifier', 'password', 'otp_secret', 'card_number', 'cardholder_name', 'exp_month', 'exp_year', 'cvc',
                'billing_postal_code', 'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'country')


class VaultAdd(BaseModel):
    model_config = ConfigDict(extra='forbid')
    kind: Literal['login', 'payment', 'address']
    label: str = Field(min_length=1, max_length=200)
    origin: str = Field(default='', max_length=500)
    secret: dict[str, str] = Field(max_length=20)

    @field_validator('secret')
    @classmethod
    def _fields(cls, v):
        if any(k not in VAULT_FIELDS or len(x) > 2000 for k, x in v.items()):
            raise ValueError('unknown or too long field')
        return v


@router.get('/profiles/{profile}/vault')
def vault_list(profile: str, request: Request):
    settings = request.app.state.settings
    reply = credentials.vault(settings, selected(settings, 'profiles', profile), {'action': 'list'})
    return {'items': reply.get('items') or [], 'key_storage': reply.get('key_storage')}


@router.post('/profiles/{profile}/vault')
def vault_add(profile: str, body: VaultAdd, request: Request):
    settings = request.app.state.settings
    reply = credentials.vault(settings, selected(settings, 'profiles', profile),
                              {'action': 'add', 'kind': body.kind, 'label': body.label, 'origin': body.origin, 'secret': body.secret})
    return {'ok': True, 'item': reply.get('item')}


@router.delete('/profiles/{profile}/vault/{item}')
def vault_remove(profile: str, item: str, request: Request):
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', item):
        raise HTTPException(422, 'Invalid item id')
    settings = request.app.state.settings
    reply = credentials.vault(settings, selected(settings, 'profiles', profile), {'action': 'remove', 'id': item})
    if reply.get('removed') is not True:
        raise HTTPException(404, 'No such vault item')
    return {'ok': True}


class SecretsAct(BaseModel):
    model_config = ConfigDict(extra='forbid')
    provider: Literal['bitwarden', 'onepassword']
    action: Literal['status', 'sync', 'disable', 'set', 'remove']
    env_var: str | None = Field(default=None, max_length=100)
    reference: str | None = Field(default=None, max_length=120)


@router.post('/profiles/{profile}/secrets')
def secrets_act(profile: str, body: SecretsAct, request: Request):
    settings = request.app.state.settings
    return credentials.secrets(settings, selected(settings, 'profiles', profile), body.provider, body.action, body.env_var, body.reference)


class PeerAct(BaseModel):
    model_config = ConfigDict(extra='forbid')
    action: Literal['list', 'add', 'remove', 'run', 'status', 'stop']
    name: str | None = Field(default=None, max_length=64)
    url: str | None = Field(default=None, max_length=200)
    key: str | None = Field(default=None, max_length=500)
    note: str | None = Field(default=None, max_length=200)
    target: str | None = Field(default=None, max_length=130)
    run_id: str | None = Field(default=None, max_length=128)
    message: str | None = Field(default=None, max_length=12000)
    idempotency_key: str | None = Field(default=None, max_length=128)


@router.post('/profiles/{profile}/peers')
def peers_act(profile: str, body: PeerAct, request: Request):
    settings = request.app.state.settings
    return peers.act(settings, selected(settings, 'profiles', profile), body.model_dump())


class DistributionAct(BaseModel):
    model_config = ConfigDict(extra='forbid')
    source_id: str = Field(pattern=r'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')
    name: str | None = Field(default=None, pattern=r'^[a-z0-9][a-z0-9_-]{0,63}$')
    profile: str | None = Field(default=None, pattern=r'^[a-z0-9][a-z0-9_-]{0,63}$')
    digest: str | None = Field(default=None, pattern=r'^[0-9a-f]{64}$')
    force: bool = False
    force_config: bool = False


@router.get('/profiles/{profile}/distributions')
def distribution_sources(profile: str, request: Request):
    settings = request.app.state.settings
    return distributions.listing(settings, selected(settings, 'profiles', profile))


@router.post('/profiles/{profile}/distributions/{action}')
def distribution_act(profile: str, action: Literal['preview', 'install', 'update'], body: DistributionAct, request: Request):
    settings = request.app.state.settings
    return distributions.act(settings, selected(settings, 'profiles', profile), action, body.source_id, body.name, body.profile, body.digest, body.force, body.force_config)
