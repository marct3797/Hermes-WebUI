"""Real, per-user PTYs with bounded byte-offset replay."""
import asyncio
import base64
from collections import deque
from datetime import datetime, timezone
import errno
import fcntl
import os
import pty
import shutil
import signal
import struct
import subprocess
import termios
import uuid

REPLAY_BYTES = 256 * 1024
INPUT_BYTES = 16 * 1024


def dimensions(cols, rows):
    if type(cols) is not int or type(rows) is not int or not (1 <= cols <= 500 and 1 <= rows <= 300):
        raise ValueError('terminal dimensions out of range')


def _controlling_tty():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


class Terminal:
    def __init__(self, cli, workspace, command, cwd, cols, rows, secret_env_names=()):
        dimensions(cols, rows)
        self.id = uuid.uuid4().hex
        self.cli, self.workspace = cli, workspace
        self.created_at = datetime.now(timezone.utc).isoformat()
        self.chunks = deque()
        self.offset = 0
        self.buffer_size = 0
        self.changed = asyncio.Event()
        self.fd, slave = pty.openpty()
        self.process: subprocess.Popen
        try:
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
            env = dict(os.environ, TERM='xterm-256color')
            # Service authentication must never leak into child CLI environments.
            for key in secret_env_names:
                env.pop(key, None)
            self.process = subprocess.Popen(command, cwd=cwd, stdin=slave, stdout=slave, stderr=slave,
                                            env=env, preexec_fn=_controlling_tty, close_fds=True)
            os.set_blocking(self.fd, False)
            asyncio.get_running_loop().add_reader(self.fd, self._read)
            self.waiter = asyncio.create_task(self._wait())
        except BaseException:
            os.close(self.fd)
            self.fd = -1
            if hasattr(self, 'process'):
                self.process.kill()
                self.process.wait()
            raise
        finally:
            os.close(slave)

    def _notify(self):
        old, self.changed = self.changed, asyncio.Event()
        old.set()

    def _read(self):
        try:
            data = os.read(self.fd, 8192)
        except BlockingIOError:
            return
        except OSError as exc:
            if exc.errno not in (errno.EIO, errno.EBADF):
                raise
            data = b''
        if not data:
            self._close_fd()
            self._notify()
            return
        self.chunks.append((self.offset, data))
        self.offset += len(data)
        self.buffer_size += len(data)
        while self.buffer_size > REPLAY_BYTES:
            start, chunk = self.chunks.popleft()
            excess = self.buffer_size - REPLAY_BYTES
            if len(chunk) > excess:
                self.chunks.appendleft((start + excess, chunk[excess:]))
                self.buffer_size -= excess
            else:
                self.buffer_size -= len(chunk)
        self._notify()

    def _close_fd(self):
        if self.fd != -1:
            asyncio.get_running_loop().remove_reader(self.fd)
            os.close(self.fd)
            self.fd = -1

    async def _wait(self):
        while self.process.poll() is None:
            await asyncio.sleep(.03)
        self._notify()

    def describe(self):
        result = dict(id=self.id, cli=self.cli, workspace=self.workspace, pid=self.process.pid,
                      running=self.process.poll() is None, created_at=self.created_at)
        if not result['running']:
            result['exit_code'] = self.process.returncode
        return result

    def replay(self, after):
        if type(after) is not int or not 0 <= after <= self.offset:
            raise ValueError('invalid replay offset')
        first = self.offset - self.buffer_size
        frames = []
        if after < first:
            frames.append(dict(type='gap', requested=after, available_from=first))
            after = first
        for offset, data in self.chunks:
            if offset + len(data) > after:
                begin = max(after, offset)
                frames.append(dict(type='output', data=base64.b64encode(data[begin-offset:]).decode(), offset=begin))
        return frames

    async def write(self, data):
        if len(data) > INPUT_BYTES:
            raise ValueError('input too large')
        if self.fd == -1 or self.process.poll() is not None:
            raise ValueError('terminal exited')
        async with asyncio.timeout(2):
            while data:
                try:
                    count = os.write(self.fd, data)
                    data = data[count:]
                except BlockingIOError:
                    await asyncio.sleep(.01)

    def resize(self, cols, rows):
        dimensions(cols, rows)
        if self.fd == -1 or self.process.poll() is not None:
            raise ValueError('terminal exited')
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

    async def terminate(self):
        # Kill the original session's group, including children after leader exit.
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(self.process.pid, sig)
            except ProcessLookupError:
                break
            if sig == signal.SIGTERM:
                await asyncio.sleep(.1)
        await self.waiter
        self._close_fd()
        self._notify()


class TerminalManager:
    def __init__(self, settings):
        self.settings = settings
        self.terminals = {}

    def create(self, cli, workspace, cols=80, rows=24):
        if len(self.terminals) >= self.settings.max_terminals:
            raise ValueError('maximum terminal count reached; delete a terminal first')
        configured = next((item for item in self.settings.clis if item['id'] == cli), None)
        if configured is None:
            raise ValueError('unknown CLI')
        command = configured['command']
        executable = shutil.which(command[0])
        if executable is None:
            raise ValueError('configured executable unavailable')
        cwd = self.settings.workspace_path(workspace)
        terminal = Terminal(cli, workspace, [executable, *command[1:]], cwd, cols, rows,
                            secret_env_names=(self.settings.token_env,))
        self.terminals[terminal.id] = terminal
        return terminal

    async def delete(self, identifier):
        terminal = self.terminals[identifier]
        await terminal.terminate()
        self.terminals.pop(identifier, None)

    async def close(self):
        await asyncio.gather(*(terminal.terminate() for terminal in list(self.terminals.values())))
        self.terminals.clear()
