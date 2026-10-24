"""Authenticated local daemon API. No inference or account probes on info."""
import argparse
import asyncio
import base64
import binascii
from contextlib import asynccontextmanager
import hmac
import json
import os
import shutil

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, StrictInt

from . import __version__
from .auth import AuthChecker
from .config import Settings
from .operations import router as operations_router
from .terminals import TerminalManager


class CreateTerminal(BaseModel):
    model_config = ConfigDict(extra='forbid')
    cli: str
    workspace: str
    cols: StrictInt = 80
    rows: StrictInt = 24


def create_app(settings):
    if isinstance(settings, dict):
        settings = Settings.from_dict(settings)
    if os.geteuid() == 0:
        raise ValueError('hostd refuses root runtime')
    token = settings.token()
    manager = TerminalManager(settings)
    checker = AuthChecker(settings)

    @asynccontextmanager
    async def lifespan(app):
        try:
            yield
        finally:
            await manager.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = settings
    app.state.terminals = manager
    # Operations-Router läuft innerhalb derselben Bearer-/Origin-/Bodylimit-Grenze, keine separate offene App.
    app.include_router(operations_router)

    def authorize(headers):
        supplied = headers.get('authorization', '')
        if not supplied.isascii() or not hmac.compare_digest(supplied, 'Bearer ' + token):
            return 401
        origin = headers.get('origin')
        if origin is not None and origin not in settings.allowed_origins:
            return 403
        return None

    @app.middleware('http')
    async def guard(request: Request, call_next):
        rejected = authorize(request.headers)
        if rejected:
            return JSONResponse({'detail': 'unauthorized' if rejected == 401 else 'origin forbidden'}, status_code=rejected)
        if request.method in ('POST', 'PUT', 'PATCH'):
            limit = 4096 if request.url.path.startswith('/v1/terminals') else 1500000
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > limit:
                    return JSONResponse({'detail': 'request too large'}, status_code=413)
            request._body = bytes(body)
        return await call_next(request)

    @app.get('/v1/info')
    async def info():
        return dict(version=__version__, clis=[dict(id=cli['id'], label=cli['label'],
                    available=shutil.which(cli['command'][0]) is not None, authenticated=checker.cached_state(cli['id']),
                    auth_note='Status per CLI-Befehl geprüft; leer, solange noch nicht geprüft.') for cli in settings.clis],
                    workspaces=[dict(id=w['id'], label=w['label']) for w in settings.workspaces])

    @app.get('/v1/auth')
    async def auth(refresh: int = 0):
        return {'clis': await checker.all(bool(refresh))}

    @app.get('/v1/terminals')
    async def terminals():
        manager.prune()
        return {'terminals': [terminal.describe() for terminal in manager.terminals.values()]}

    @app.post('/v1/terminals')
    async def create(body: CreateTerminal):
        try:
            return manager.create(body.cli, body.workspace, body.cols, body.rows).describe()
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from None
        except OSError:
            raise HTTPException(400, 'configured CLI or workspace unavailable') from None

    @app.delete('/v1/terminals/{identifier}')
    async def delete(identifier: str):
        if identifier not in manager.terminals:
            raise HTTPException(404, 'terminal not found')
        await manager.delete(identifier)
        return {'ok': True}

    @app.websocket('/v1/terminals/{identifier}/stream')
    async def stream(ws: WebSocket, identifier: str):
        rejected = authorize(ws.headers)
        if rejected:
            await ws.close(code=4401 if rejected == 401 else 4403)
            return
        terminal = manager.terminals.get(identifier)
        if terminal is None:
            await ws.close(code=4404)
            return
        try:
            after = int(ws.query_params.get('after', '0'))
            terminal.replay(after)
        except ValueError:
            await ws.close(code=4400)
            return
        await ws.accept()
        await ws.send_json({'type': 'state', 'terminal': terminal.describe()})

        async def output():
            nonlocal after
            state = terminal.describe()
            while True:
                changed = terminal.changed
                for frame in terminal.replay(after):
                    async with asyncio.timeout(10):
                        await ws.send_json(frame)
                    if frame['type'] == 'output':
                        after = frame['offset'] + len(base64.b64decode(frame['data']))
                    else:
                        after = frame['available_from']
                current = terminal.describe()
                if current != state:
                    async with asyncio.timeout(10):
                        await ws.send_json({'type': 'state', 'terminal': current})
                    state = current
                if not current['running'] and terminal.fd == -1:
                    return
                await changed.wait()

        async def input_frames():
            while True:
                raw = await ws.receive_text()
                if len(raw.encode('utf-8')) > 24 * 1024:
                    raise ValueError('frame too large')
                frame = json.loads(raw)
                if not isinstance(frame, dict):
                    raise ValueError('invalid frame')
                if frame.get('type') == 'input' and set(frame) == {'type', 'data'}:
                    if not isinstance(frame['data'], str):
                        raise ValueError('invalid input')
                    await terminal.write(base64.b64decode(frame['data'], validate=True))
                elif frame.get('type') == 'resize' and set(frame) == {'type', 'cols', 'rows'}:
                    terminal.resize(frame['cols'], frame['rows'])
                else:
                    raise ValueError('unsupported frame')

        tasks = [asyncio.create_task(output()), asyncio.create_task(input_frames())]
        code = 1000
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except WebSocketDisconnect:
            pass
        except (ValueError, TypeError, KeyError, binascii.Error, OSError, TimeoutError):
            code = 1008
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            try:
                await ws.close(code=code)
            except (RuntimeError, WebSocketDisconnect):
                pass

    return app


def main():
    parser = argparse.ArgumentParser(description='Per-user native CLI PTY daemon')
    parser.add_argument('--config', required=True, help='Absolute JSON configuration path')
    args = parser.parse_args()
    settings = Settings.load(args.config)
    app = create_app(settings)
    import uvicorn
    uvicorn.run(app, host=settings.listen_host, port=settings.port, access_log=False,
                ws_max_size=24 * 1024, ws_max_queue=4)


if __name__ == '__main__':
    main()
