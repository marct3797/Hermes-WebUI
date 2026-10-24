"""Descriptor-relative workspace access: symlinks are never followed."""
import base64
import binascii
import errno
import mimetypes
import os
from contextlib import contextmanager
from pathlib import PurePosixPath
import stat

from fastapi import HTTPException

LIMIT = 65536
UPLOAD_LIMIT = 1048576
DENIED = {'.git', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.hermes', '.npmrc', '.pypirc',
          '.netrc', '.git-credentials', 'auth.json', 'credentials.json', 'credentials',
          'config.yaml', 'config.yml', 'secrets.yaml', 'secrets.json', 'id_rsa', 'id_ed25519',
          'state.db', 'kanban.db'}


def forbidden(name):
    name = name.lower()
    return (name in DENIED or (name.startswith('.') and name != '.gitignore') or name.startswith('config.') or name.endswith('.env') or name.endswith(('.pem', '.key', '.p12', '.pfx', '.db', '.sqlite', '.sqlite3'))
            or any(word in name for word in ('credential', 'secret', 'token')))


def parts(path):
    if not isinstance(path, str) or '\\' in path or '\x00' in path or path.startswith('/'):
        raise HTTPException(403, 'Path denied')
    pieces = path.split('/') if path else []
    if any(p in ('..', '.') or not p or forbidden(p) for p in pieces):
        raise HTTPException(403, 'Path denied')
    return pieces


@contextmanager
def opened(root, path='', *, create=False):
    names = parts(path)
    fds = []
    try:
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        fds.append(fd)
        for index, name in enumerate(names):
            last = index == len(names) - 1
            flags = os.O_NOFOLLOW | os.O_NONBLOCK
            flags |= (os.O_WRONLY | os.O_CREAT | os.O_EXCL) if create and last else os.O_RDONLY
            if not last:
                flags |= os.O_DIRECTORY
            fd = os.open(name, flags, 0o600, dir_fd=fd)
            fds.append(fd)
        if create and not names:
            raise HTTPException(403, 'Path denied')
        mode = os.fstat(fd).st_mode
        if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
            raise HTTPException(403, 'Special file denied')
        yield fd
    except FileExistsError:
        raise HTTPException(409, 'File already exists') from None
    except FileNotFoundError:
        raise HTTPException(404, 'File not found') from None
    except OSError as exc:
        raise HTTPException(403 if exc.errno in (errno.ELOOP, errno.ENOTDIR, errno.EACCES) else 400,
                            'File operation denied') from None
    finally:
        for fd in reversed(fds):
            os.close(fd)


def browse(root, workspace, path):
    with opened(root, path) as fd:
        result = {'workspace': workspace, 'path': path, 'entries': []}
        if stat.S_ISDIR(os.fstat(fd).st_mode):
            entries = []
            with os.scandir(fd) as items:
                for item in items:
                    if forbidden(item.name) or item.is_symlink():
                        continue
                    info = item.stat(follow_symlinks=False)
                    if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                        continue
                    entries.append({'name': item.name, 'path': str(PurePosixPath(path) / item.name),
                                    'kind': 'directory' if stat.S_ISDIR(info.st_mode) else 'file',
                                    'size': info.st_size})
                    if len(entries) > 1000:
                        result['truncated'] = True
                        break
            result['entries'] = sorted(entries[:1000], key=lambda e: e['name'])
        else:
            data = os.read(fd, LIMIT + 1)
            mime = mimetypes.guess_type(path)[0] or 'text/plain'
            if b'\x00' in data or any(b < 32 and b not in (9, 10, 13) for b in data) or mime == 'application/pdf':
                raise HTTPException(415, 'Binary preview unavailable; use download')
            try:
                import codecs
                content = codecs.getincrementaldecoder('utf-8')().decode(data[:LIMIT], final=len(data) <= LIMIT)
            except UnicodeDecodeError:
                raise HTTPException(415, 'Binary preview unavailable') from None
            result.update(content=content, truncated=len(data) > LIMIT, mime=mime)
        return result


def upload(root, path, encoded):
    parts(path)
    if len(encoded) > 4 * ((UPLOAD_LIMIT + 2) // 3):
        raise HTTPException(413, 'Upload exceeds 1 MiB')
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise HTTPException(400, 'Invalid base64') from None
    if len(data) > UPLOAD_LIMIT:
        raise HTTPException(413, 'Upload exceeds 1 MiB')
    with opened(root, path, create=True) as fd:
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            view = view[written:]
        os.fsync(fd)
    return {'ok': True, 'path': path, 'size': len(data)}


def download(root, path):
    with opened(root, path) as fd:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise HTTPException(400, 'Not a file')
        if os.fstat(fd).st_size > 16 * UPLOAD_LIMIT:
            raise HTTPException(413, 'Download exceeds 16 MiB')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            data = stream.read(16 * UPLOAD_LIMIT + 1)
        if len(data) > 16 * UPLOAD_LIMIT:
            raise HTTPException(413, 'Download exceeds 16 MiB')
        return data
