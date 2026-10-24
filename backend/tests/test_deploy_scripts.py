"""Deploy-Skripte: Dateien mit Geheimnissen entstehen nie für andere lesbar (der Modus wird VOR dem chmod 600 gemessen)."""
import json
import os
import shutil
import stat
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

DEPLOY = Path(__file__).resolve().parents[2] / "deploy"


@pytest.fixture
def box(tmp_path):
    bin_, log = tmp_path / "bin", tmp_path / "modes.log"
    bin_.mkdir()
    real = shutil.which("chmod")
    stubs = {
        "chmod": f'#!/bin/bash\nfor a in "$@"; do [ -e "$a" ] && stat -c "%a %n" "$a" >> {log}; done\nexec {real} "$@"\n',
        "sudo": '#!/bin/bash\nwhile [[ "$1" == --* ]]; do shift; done\nexec "$@"\n',
        "docker": '#!/bin/bash\ncase "$1" in exec) printf %s synthetic-key-0123456789;; esac\nexit 0\n',
        "curl": "#!/bin/bash\nexit 0\n",
    }
    for name, body in stubs.items():
        (bin_ / name).write_text(body)
        (bin_ / name).chmod(0o755)
    return SimpleNamespace(bin=bin_, log=log, tmp=tmp_path, home=tmp_path / "wui")


def run(box, script, *args, stdin=""):
    env = {**os.environ, "PATH": f"{box.bin}:{os.environ['PATH']}", "HOME": str(box.tmp)}
    env.pop("HERMES_CONTAINER", None)
    # Übliche Umask 022: ohne eigene Vorkehrung des Skripts entstünden die Dateien für alle lesbar.
    return subprocess.run(["bash", "-c", 'umask 022; exec bash "$@"', "x", str(DEPLOY / script), *args], input=stdin,
                          capture_output=True, text=True, env=env, timeout=60)


def secret_modes(box):
    rows = [line.split(" ", 1) for line in box.log.read_text().splitlines()] if box.log.exists() else []
    return [(int(mode, 8), name) for mode, name in rows if name.endswith((".new", "webui.env"))]


def assert_private(box):
    modes = secret_modes(box)
    assert modes, "kein chmod auf eine Geheimnisdatei beobachtet: Test prüft nichts"
    assert all(mode & 0o077 == 0 for mode, _ in modes), modes


def prepare(box, env_lines="", agents=None):
    (box.home / "config").mkdir(parents=True)
    envf = box.home / "webui.env"
    envf.write_text(env_lines)
    envf.chmod(0o600)
    rt = {"id": "hermes", "base_url": "http://127.0.0.1:1", "api_key_env": "HERMES_KEY_X", "multiplex": True, "agents": agents or ["default"]}
    (box.home / "config" / "hosts.json").write_text(json.dumps({"hosts": [{"id": "h", "runtimes": [rt]}]}))
    return envf


def test_deploy_creates_directories_and_env_private_and_set_var_is_private(box):
    # frischer Zielordner: Verzeichnisse und webui.env nur für den Besitzer
    r = run(box, "deploy.sh", str(box.home))
    assert r.returncode == 2 and "FEHLT" in r.stdout  # OIDC-Werte fehlen, das Skript endet vor dem Start
    for d in (box.home, box.home / "config", box.home / "data"):
        assert stat.S_IMODE(d.stat().st_mode) & 0o077 == 0, d
    assert stat.S_IMODE((box.home / "webui.env").stat().st_mode) == 0o600


def test_deploy_set_var_writes_the_key_file_private(box):
    prepare(box, "HERMES_CONTAINER=c\n")
    run(box, "deploy.sh", str(box.home))
    assert "HERMES_KEY_X=synthetic-key-0123456789" in (box.home / "webui.env").read_text()
    assert_private(box)


def test_profile_keys_writes_private(box):
    prepare(box, f"HERMES_DATA={box.tmp}/data\n", agents=[{"id": "eta", "api_key_env": "HERMES_KEY_ETA"}])
    cfg = box.home / "config" / "hosts.json"
    cfg.write_text(json.dumps({"hosts": [{"id": "h", "runtimes": [{"id": "hermes", "multiplex": True, "agents": [{"id": "eta", "api_key_env": "HERMES_KEY_ETA"}]}]}]}))
    (box.tmp / "data" / "profiles" / "eta").mkdir(parents=True)
    (box.tmp / "data" / "profiles" / "eta" / ".env").write_text("API_SERVER_KEY=synthetic-key-0123456789\n")
    r = run(box, "profile-keys.sh", str(box.home))
    assert "HERMES_KEY_ETA gesetzt" in r.stdout, r.stdout + r.stderr
    assert_private(box)


def test_dashboard_token_is_written_private(box):
    prepare(box, "HERMES_CONTAINER=c\n")
    r = run(box, "dashboard.sh", str(box.home))
    assert "HERMES_DASHBOARD_TOKEN neu erzeugt" in r.stdout, r.stdout + r.stderr
    assert_private(box)


def test_add_host_writes_the_key_private(box):
    prepare(box)
    r = run(box, "add-host.sh", "box", "Box", "10.0.0.9", "--home", str(box.home), stdin="synthetic-key-0123456789\n")
    assert "HERMES_KEY_BOX gesetzt" in r.stdout, r.stdout + r.stderr
    assert_private(box)
