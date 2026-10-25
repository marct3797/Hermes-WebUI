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
        "chmod": f'#!/bin/bash\nfor a in "$@"; do [ -e "$a" ] && (stat -c "%a %n" "$a" 2>/dev/null || stat -f "%Lp %N" "$a") >> {log}; done\nexec {real} "$@"\n',
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


OIDC = "HERMES_WEBUI_OIDC_ISSUER=https://id.example\nHERMES_WEBUI_OIDC_CLIENT_ID=c\nHERMES_WEBUI_OIDC_CLIENT_SECRET=s\nHERMES_WEBUI_OIDC_ALLOWED_SUB=1\n"


def test_fresh_install_starts_from_one_machine_and_one_agent(box):
    """Der Standard ohne eigene Config ist ein Rechner mit einem Agent; jede dort genannte Key-Variable steht auch in webui.env."""
    run(box, "deploy.sh", str(box.home))
    hosts = json.loads((box.home / "config" / "hosts.json").read_text())["hosts"]
    assert len(hosts) == 1 and len(hosts[0]["runtimes"]) == 1
    rt = hosts[0]["runtimes"][0]
    assert rt["agents"] == ["default"] and rt["multiplex"] is False and "dashboard" not in rt
    env_names = {line.split("=", 1)[0] for line in (box.home / "webui.env").read_text().splitlines() if "=" in line and not line.startswith("#")}
    assert rt["api_key_env"] in env_names


def test_fleet_example_stays_available_for_multiplex_gateways():
    fleet = json.loads((DEPLOY / "hosts.multiplex.example.json").read_text())["hosts"][0]["runtimes"][0]
    assert fleet["multiplex"] is True and len(fleet["agents"]) > 1


def test_deploy_warns_about_agent_keys_that_are_missing(box):
    prepare(box, OIDC + "HERMES_KEY_X=a\n", agents=[{"id": "eta", "api_key_env": "HERMES_KEY_ETA"}])
    r = run(box, "deploy.sh", str(box.home))
    assert "HINWEIS" in r.stdout and "HERMES_KEY_ETA" in r.stdout and r.returncode == 0, r.stdout + r.stderr


def test_add_host_dashboard_url_wins_over_port_and_is_written_as_given(box):
    prepare(box, OIDC)
    r = run(box, "add-host.sh", "box", "Box", "10.0.0.9", "--home", str(box.home), "--dashboard-url", "http://127.0.0.1:19119",
            stdin="synthetic-key-0123456789\ndash-token-0123456789\n")
    assert r.returncode == 0, r.stdout + r.stderr
    rt = next(h for h in json.loads((box.home / "config" / "hosts.json").read_text())["hosts"] if h["id"] == "box")["runtimes"][0]
    assert rt["dashboard"]["base_url"] == "http://127.0.0.1:19119" and rt["dashboard"]["token_env"] == "HERMES_DASHBOARD_TOKEN_BOX"


@pytest.mark.parametrize("url", ["ftp://127.0.0.1:1", "http://", "127.0.0.1:19119", "http://127.0.0.1:19119/pfad"])
def test_add_host_rejects_a_malformed_dashboard_url(box, url):
    prepare(box, OIDC)
    r = run(box, "add-host.sh", "box", "Box", "10.0.0.9", "--home", str(box.home), "--dashboard-url", url, stdin="k\n")
    assert r.returncode != 0 and "Dashboard-URL" in r.stdout + r.stderr


def test_add_host_dashboard_port_on_a_remote_address_warns_that_hermes_refuses_it(box):
    prepare(box, OIDC)
    r = run(box, "add-host.sh", "box", "Box", "10.0.0.9", "--home", str(box.home), "--dashboard-port", "9119", stdin="synthetic-key-0123456789\ndash-token-0123456789\n")
    assert "Tunnel" in r.stdout and "--dashboard-url" in r.stdout


# install-hostd.sh prüft Arbeitsordner vor jeder Installation. Die Prüfung nutzt `cd && pwd -P` statt `realpath -e` (macOS), darum festgehalten:
@pytest.mark.parametrize("spec,expect", [
    ("ws=/gibt/es/nicht", "not an existing directory"),
    ("ws=/", "Refusing"),
    ("kaputt", "Invalid --workspace"),
    ("ws=relativ/pfad", "Invalid --workspace"),
])
def test_install_hostd_rejects_bad_workspaces_before_installing(box, spec, expect):
    r = run(box, "install-hostd.sh", "--no-start", "--workspace", spec)
    assert r.returncode == 2 and expect in r.stderr, (r.stdout, r.stderr)
    assert not (box.tmp / ".local").exists()  # nichts installiert


def test_install_hostd_refuses_the_home_directory_also_through_a_symlink(box):
    link = box.tmp.parent / (box.tmp.name + "-link")
    link.symlink_to(box.tmp)
    for target in (box.tmp, link):
        r = run(box, "install-hostd.sh", "--no-start", "--workspace", f"ws={target}")
        assert r.returncode == 2 and "Refusing" in r.stderr, (target, r.stderr)


def test_install_hostd_accepts_a_real_directory_through_a_symlink(box):
    real = box.tmp / "projekt"; real.mkdir()
    link = box.tmp / "kurz"; link.symlink_to(real)
    marker = box.tmp / "install-begann"
    fake = box.tmp / "fakepython"  # Attrappe: beweist, dass die Prüfung bestanden wurde und die Installation beginnen würde, ohne etwas zu installieren
    fake.write_text(f"#!/bin/bash\ntouch {marker}\nexit 3\n"); fake.chmod(0o755)
    r = run(box, "install-hostd.sh", "--no-start", "--python", str(fake), "--workspace", f"ws={link}")
    assert marker.exists(), r.stderr
    assert "Refusing" not in r.stderr and "not an existing" not in r.stderr and "Invalid --workspace" not in r.stderr
