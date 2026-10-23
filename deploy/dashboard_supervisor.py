"""Keep an existing container dashboard available without restarting its gateway."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request


def read_token(path: Path) -> str:
    values = dict(line.split("=", 1) for line in path.read_text().splitlines() if "=" in line and not line.lstrip().startswith("#"))
    token = values.get("HERMES_DASHBOARD_TOKEN", "").strip()
    if len(token) < 16:
        raise ValueError("HERMES_DASHBOARD_TOKEN missing or too short")
    return token


def healthy(port: int, token: str) -> bool:
    request = urllib.request.Request(f"http://127.0.0.1:{port}/api/profiles", headers={"X-Hermes-Session-Token": token})
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            return response.status == 200 and isinstance(json.load(response).get("profiles"), list)
    except (OSError, ValueError, urllib.error.URLError):
        return False


def supervise(home: Path, container: str, port: int, interval: float = 5) -> None:
    token = read_token(home / "webui.env")
    child = None
    try:
        while True:
            # Adopt an already healthy dashboard rather than disrupting its active users.
            if not healthy(port, token) and (child is None or child.poll() is not None):
                env = {**os.environ, "HERMES_DASHBOARD_SESSION_TOKEN": token}
                child = subprocess.Popen(
                    ["docker", "exec", "-e", "HERMES_DASHBOARD_SESSION_TOKEN", container,
                     "hermes", "dashboard", "--host", "127.0.0.1", "--port", str(port), "--no-open", "--skip-build"],
                    env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
                print("Dashboard start requested; checking authenticated readiness", flush=True)
            time.sleep(interval)
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--container", required=True)
    parser.add_argument("--port", type=int, default=9122)
    args = parser.parse_args()
    if not (1 <= args.port <= 65535):
        parser.error("invalid port")
    supervise(args.home, args.container, args.port)


if __name__ == "__main__":
    main()
