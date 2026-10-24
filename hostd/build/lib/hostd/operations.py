"""Operations router; mount inside the daemon's bearer/origin boundary."""
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from . import workspace as files
from . import native, sessions

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
def git(request: Request, workspace: str):
    return native.git(workspace_root(request, workspace))


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


@router.post('/manage/{profile}/{kind}/{action}')
def management_action(request: Request, profile: str, kind: str, action: str, body: Action):
    settings = request.app.state.settings
    return native.act(settings, selected(settings, 'profiles', profile), kind, action, body.id)
