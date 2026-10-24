"""Descriptor-relative workspace access: symlinks are never followed."""
import base64
import binascii
import errno
import hashlib
import mimetypes
import os
import secrets
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
def mapped():
    """Dateisystemfehler einheitlich auf HTTP-Statuscodes abbilden."""
    try:
        yield
    except FileExistsError:
        raise HTTPException(409, 'File already exists') from None
    except FileNotFoundError:
        raise HTTPException(404, 'File not found') from None
    except OSError as exc:
        raise HTTPException(403 if exc.errno in (errno.ELOOP, errno.ENOTDIR, errno.EACCES) else 400,
                            'File operation denied') from None


def walk(root, names):
    """Ordnerkette descriptor-relativ oeffnen; gibt alle offenen fds zurueck (Aufrufer schliesst)."""
    fds = []
    try:
        fds.append(os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))
        for name in names:
            fds.append(os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fds[-1]))
    except BaseException:
        for fd in reversed(fds):
            os.close(fd)
        raise
    return fds


@contextmanager
def parent(root, path):
    """Liefert (dirfd, name): der Elternordner des Ziels, ohne je einem Symlink zu folgen."""
    names = parts(path)
    if not names:
        raise HTTPException(403, 'Path denied')
    with mapped():
        fds = walk(root, names[:-1])
        try:
            yield fds[-1], names[-1]
        finally:
            for fd in reversed(fds):
                os.close(fd)


@contextmanager
def opened(root, path='', *, create=False):
    names = parts(path)
    fds = []
    with mapped():
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
        finally:
            for fd in reversed(fds):
                os.close(fd)


def read_all(fd, limit):
    chunks, total = [], 0
    while total < limit:
        chunk = os.read(fd, min(65536, limit - total))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
    return b''.join(chunks)


def is_binary(data):
    return b'\x00' in data or any(b < 32 and b not in (9, 10, 13) for b in data)


def browse(root, workspace, path, full=False):
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
                                    'size': info.st_size, 'mtime': int(info.st_mtime)})
                    if len(entries) > 1000:
                        result['truncated'] = True
                        break
            result['entries'] = sorted(entries[:1000], key=lambda e: e['name'])
        else:
            # full=True liest bis 1 MiB (Editor); sonst nur die 64-KiB-Vorschau. sha256 immer ueber die ganze Datei.
            data = read_all(fd, UPLOAD_LIMIT + 1)
            shown = data[:UPLOAD_LIMIT if full else LIMIT]
            mime = mimetypes.guess_type(path)[0] or 'text/plain'
            if is_binary(shown) or mime == 'application/pdf':
                raise HTTPException(415, 'Binary preview unavailable; use download')
            try:
                import codecs
                content = codecs.getincrementaldecoder('utf-8')().decode(shown, final=len(data) <= len(shown))
            except UnicodeDecodeError:
                raise HTTPException(415, 'Binary preview unavailable') from None
            whole = len(data) <= UPLOAD_LIMIT
            result.update(content=content, truncated=len(data) > len(shown), mime=mime, size=len(data) if whole else None,
                          editable=whole, mtime=int(os.fstat(fd).st_mtime))
            if whole:
                result['sha256'] = hashlib.sha256(data).hexdigest()
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


def sha_of(fd):
    os.lseek(fd, 0, os.SEEK_SET)
    return hashlib.sha256(read_all(fd, UPLOAD_LIMIT + 1)).hexdigest()


def write(root, path, content, expected_sha256=None, create=False):
    data = content.encode('utf-8')
    if len(data) > UPLOAD_LIMIT:
        raise HTTPException(413, 'Content exceeds 1 MiB')
    if is_binary(data):
        raise HTTPException(415, 'Binary content denied')
    with parent(root, path) as (directory, name), mapped():
        tmp = '.hostd-tmp-' + secrets.token_hex(8)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        try:
            mode = 0o600
            if not create:
                if not expected_sha256:
                    raise HTTPException(422, 'expected_sha256 required to overwrite')
                with open_existing(directory, name) as old:
                    mode = stat.S_IMODE(os.fstat(old).st_mode)
                    if os.fstat(old).st_size > UPLOAD_LIMIT or sha_of(old) != expected_sha256:
                        raise HTTPException(409, 'File changed since it was read')
            os.fchmod(fd, mode)
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
            os.fsync(fd)
            if create:
                # link() ueberschreibt nie: atomar "nur neu".
                os.link(tmp, name, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
            else:
                with open_existing(directory, name) as old:  # zweite Pruefung kurz vor dem Tausch
                    if sha_of(old) != expected_sha256:
                        raise HTTPException(409, 'File changed since it was read')
                os.rename(tmp, name, src_dir_fd=directory, dst_dir_fd=directory)
                tmp = None
        finally:
            os.close(fd)
            if tmp:
                os.unlink(tmp, dir_fd=directory)  # nur die eigene Temp-Datei
    return {'ok': True, 'path': path, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}


@contextmanager
def open_existing(directory, name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise HTTPException(403, 'Special file denied')
        if is_binary(read_all(fd, 8192)):
            raise HTTPException(415, 'Binary file denied')
        yield fd
    finally:
        os.close(fd)


def mkdir(root, path):
    with parent(root, path) as (directory, name), mapped():
        os.mkdir(name, 0o700, dir_fd=directory)
    return {'ok': True, 'path': path}


def move(root, source, target):
    if source == target or (target + '/').startswith(source + '/'):
        raise HTTPException(400, 'Invalid move')
    with parent(root, source) as (src_dir, src), parent(root, target) as (dst_dir, dst), mapped():
        info = os.stat(src, dir_fd=src_dir, follow_symlinks=False)
        if stat.S_ISREG(info.st_mode):
            # link+unlink statt rename: scheitert atomar, wenn das Ziel existiert.
            os.link(src, dst, src_dir_fd=src_dir, dst_dir_fd=dst_dir, follow_symlinks=False)
            os.unlink(src, dir_fd=src_dir)
        elif stat.S_ISDIR(info.st_mode):
            # shortcut: Ordner lassen sich nicht hart verlinken, Pruefung und rename sind nicht atomar; bei Bedarf renameat2(NOREPLACE) per ctypes.
            try:
                os.stat(dst, dir_fd=dst_dir, follow_symlinks=False)
            except FileNotFoundError:
                os.rename(src, dst, src_dir_fd=src_dir, dst_dir_fd=dst_dir)
            else:
                raise HTTPException(409, 'Target exists')
        else:
            raise HTTPException(403, 'Special file denied')
    return {'ok': True, 'from': source, 'to': target}
