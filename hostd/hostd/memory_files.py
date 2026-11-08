"""Lesen/Schreiben der Hermes-Gedaechtnisdateien MEMORY.md/USER.md je Profil."""
import errno
import hashlib
import os
import stat
from contextlib import contextmanager
from datetime import datetime, timezone

from fastapi import HTTPException

NAMES = ('MEMORY.md', 'USER.md')
LIMIT = 262144  # 256 KiB
BACKUP_KEEP = 5
EMPTY_SHA = hashlib.sha256(b'').hexdigest()
CHANGED = 'Die Datei wurde inzwischen geaendert'


def profile_root(settings, profile):
    from .operations import selected, value
    entry = selected(settings, 'profiles', profile)
    root = value(entry, 'path')
    if not isinstance(root, str) or not root:
        from fastapi import HTTPException as _HTTP
        raise _HTTP(404, 'Profile not found')
    return root


@contextmanager
def memdir(root):
    """memories-Ordner descriptor-relativ oeffnen (Symlinks nie folgen)."""
    try:
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError as exc:
        raise HTTPException(404 if exc.errno == errno.ENOENT else 403, 'Profile not found') from None
    try:
        try:
            sub = os.open('memories', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        except FileNotFoundError:
            yield None
            return
        except OSError:
            raise HTTPException(403, 'File operation denied') from None
        try:
            yield sub
        finally:
            os.close(sub)
    finally:
        os.close(fd)


def digest_of(fd):
    os.lseek(fd, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    while True:
        chunk = os.read(fd, 65536)
        if not chunk:
            break
        digest.update(chunk)
    return digest.hexdigest()


def stat_entry(dirfd, name):
    """lstat ohne Symlink-Folge: fehlt -> None, Link/Spezialdatei -> 403."""
    try:
        info = os.lstat(os.path.join('/proc/self/fd', str(dirfd), name))
    except FileNotFoundError:
        return None
    except OSError:
        raise HTTPException(403, 'File operation denied') from None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise HTTPException(403, 'File operation denied')
    return info


def read_one(dirfd, name):
    info = stat_entry(dirfd, name) if dirfd is not None else None
    if info is None:
        return {'name': name, 'content': '', 'sha256': EMPTY_SHA, 'size': 0, 'mtime': 0.0}
    if info.st_size > LIMIT:
        raise HTTPException(413, 'File too large')
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dirfd)
    except OSError:
        raise HTTPException(403, 'File operation denied') from None
    try:
        chunks, total = [], 0
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > LIMIT:
                raise HTTPException(413, 'File too large')
        raw = b''.join(chunks)
    finally:
        os.close(fd)
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError:
        raise HTTPException(422, 'File is not valid UTF-8') from None
    return {'name': name, 'content': text, 'sha256': hashlib.sha256(raw).hexdigest(),
            'size': len(raw), 'mtime': info.st_mtime}


def prune_backups(dirfd, name):
    prefix = name + '.bak-'
    found = []
    with os.scandir(dirfd) as items:
        for item in items:
            if item.name.startswith(prefix):
                found.append(item.name)
    for stale in sorted(found)[:-BACKUP_KEEP] if len(found) > BACKUP_KEEP else []:
        try:
            os.unlink(stale, dir_fd=dirfd)
        except OSError:
            pass


def stamp():
    return datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
