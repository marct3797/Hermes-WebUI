"""Install a dedicated loopback dashboard or container-dashboard supervisor as a user unit."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
from datetime import datetime, timezone


def unit_arg(value: str) -> str:
    if any(c in value for c in "\r\n\0"):
        raise ValueError("invalid unit argument")
    return '"' + value.replace("%", "%%").replace("\\", "\\\\").replace('"', '\\"') + '"'


def backed_write(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_text() == content:
            return
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        shutil.copy2(path, path.with_name(path.name + ".bak." + stamp))
    path.write_text(content)
    path.chmod(0o600)


def install(home: Path, port: int, hermes: str | None, container: str | None, *, start: bool = True) -> Path:
    home = home.expanduser().resolve()
    home.mkdir(parents=True, exist_ok=True)
    home.chmod(0o700)
    env_file = home / "services" / "dashboard.env"
    environment = ""
    if container:
        if not (home / "webui.env").is_file():
            raise ValueError("supervisor requires existing webui.env")
        executable = Path(__file__).with_name("dashboard_supervisor.py").resolve()
        command = [sys.executable, str(executable), "--home", str(home), "--container", container, "--port", str(port)]
    else:
        if not hermes or not Path(hermes).is_file():
            raise ValueError("an absolute Hermes executable is required")
        env_file.parent.mkdir(parents=True, exist_ok=True)
        env_file.parent.chmod(0o700)
        if not env_file.exists():
            fd = os.open(env_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as stream:
                stream.write("HERMES_DASHBOARD_SESSION_TOKEN=" + secrets.token_hex(32) + "\n")
        env_file.chmod(0o600)
        environment = "EnvironmentFile=" + str(env_file).replace("%", "%%").replace(" ", "\\x20") + "\n"
        command = [hermes, "dashboard", "--host", "127.0.0.1", "--port", str(port), "--no-open", "--skip-build", "--isolated"]
    config = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "systemd" / "user"
    unit = config / "hermes-webui-dashboard.service"
    body = ("[Unit]\nDescription=Hermes WebUI dedicated dashboard\nAfter=network-online.target\n"
            "\n[Service]\nType=simple\n" + environment +
            "Environment=" + unit_arg("PATH=" + os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin")) + "\n" +
            "ExecStart=" + " ".join(map(unit_arg, command)) + "\n"
            "Restart=always\nRestartSec=5\nTimeoutStopSec=15\nUMask=0077\nNoNewPrivileges=true\n"
            "\n[Install]\nWantedBy=default.target\n")
    backed_write(unit, body)
    if start:
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
        subprocess.run(["systemctl", "--user", "enable", "--now", unit.name], check=True)
    return unit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=Path.home() / "hermes-webui")
    parser.add_argument("--port", type=int, default=9119)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--hermes", help="absolute Hermes launcher for a local dedicated dashboard")
    mode.add_argument("--container", help="existing agent container to supervise")
    parser.add_argument("--no-start", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("invalid port")
    unit = install(args.home, args.port, args.hermes, args.container, start=not args.no_start)
    print(f"Dashboard unit ready: {unit}; loopback port {args.port}; credentials not displayed")


if __name__ == "__main__":
    main()
