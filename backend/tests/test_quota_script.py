import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "deploy" / "install-quota-plugin.sh"


@pytest.fixture
def plugin(tmp_path):
    d = tmp_path / "src" / "ai-usage-tracker"
    d.mkdir(parents=True)
    (d / "plugin.yaml").write_text("name: ai-usage-tracker\n")
    return d


def run(*args):
    return subprocess.run(["bash", str(SCRIPT), *args], capture_output=True, text=True)


def test_local_dry_run_prints_link_and_enable_per_profile_and_changes_nothing(plugin, tmp_path):
    home = tmp_path / "hh"
    r = run("local", "--source", str(plugin), "--home", str(home), "--profile", "default", "--profile", "sora")
    assert r.returncode == 0 and "Trockenlauf" in r.stdout
    assert f"ln -s {plugin} {home}/plugins/ai-usage-tracker" in r.stdout
    assert "hermes plugins enable ai-usage-tracker" in r.stdout and "hermes -p sora plugins enable ai-usage-tracker" in r.stdout
    assert not home.exists()


def test_docker_dry_run_prints_cp_chown_and_restart(plugin):
    r = run("docker", "--source", str(plugin), "--container", "hermes-agent", "--owner", "1000:1000")
    assert r.returncode == 0
    assert f"docker cp {plugin} hermes-agent:/opt/data/plugins/ai-usage-tracker" in r.stdout
    assert "docker exec -u 0 hermes-agent chown -R 1000:1000 /opt/data/plugins/ai-usage-tracker" in r.stdout
    assert r.stdout.rstrip().splitlines()[-2] == "docker restart hermes-agent"


@pytest.mark.parametrize("args", [
    ["docker"],                                                       # Container und Besitzer fehlen
    ["docker", "--container", "x;y", "--owner", "1:1"],
    ["docker", "--container", "x", "--owner", "root"],
    ["local", "--profile", "a;b"],
    ["local", "--bogus"],
    ["elsewhere"],
])
def test_bad_arguments_are_rejected(plugin, args):
    r = run(args[0], "--source", str(plugin), *args[1:])
    assert r.returncode != 0


def test_wrong_source_and_existing_target_abort_without_changes(plugin, tmp_path):
    assert run("local", "--source", str(tmp_path)).returncode == 1
    home = tmp_path / "hh"
    (home / "plugins" / "ai-usage-tracker").mkdir(parents=True)
    r = run("local", "--source", str(plugin), "--home", str(home), "--apply")
    assert r.returncode == 1 and "Ziel existiert schon" in r.stderr


def test_apply_with_copy_creates_the_plugin_dir_when_hermes_is_available(plugin, tmp_path):
    # Mit einem Attrappen-`hermes` im PATH: prüft --apply und --copy, ohne ein echtes Profil anzufassen.
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "hermes").write_text("#!/bin/sh\necho \"hermes $*\" >> \"$LOG\"\n")
    (bin_dir / "hermes").chmod(0o755)
    home, log = tmp_path / "hh", tmp_path / "log"
    r = subprocess.run(["bash", str(SCRIPT), "local", "--source", str(plugin), "--home", str(home), "--copy", "--profile", "sora", "--apply"],
                       capture_output=True, text=True, env={"PATH": f"{bin_dir}:/usr/bin:/bin", "LOG": str(log), "HOME": str(tmp_path)})
    assert r.returncode == 0, r.stderr
    assert (home / "plugins" / "ai-usage-tracker" / "plugin.yaml").is_file()
    assert log.read_text() == "hermes -p sora plugins enable ai-usage-tracker\n"
