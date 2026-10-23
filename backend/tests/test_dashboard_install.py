from importlib import util
from pathlib import Path
import os
import pytest

spec = util.spec_from_file_location("dashboard_install", Path(__file__).parents[2] / "deploy/install_dashboard.py")
assert spec is not None and spec.loader is not None
installer = util.module_from_spec(spec)
spec.loader.exec_module(installer)


def test_local_dashboard_install_is_private_idempotent_and_loopback_only(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    home = tmp_path / "data"
    binary = tmp_path / "hermes"
    binary.write_text("#!/bin/sh\n")
    unit = installer.install(home, 9119, str(binary), None, start=False)
    env = home / "services/dashboard.env"
    original = env.read_bytes()
    installer.install(home, 9119, str(binary), None, start=False)
    assert env.read_bytes() == original
    assert env.stat().st_mode & 0o777 == 0o600
    assert '"127.0.0.1"' in unit.read_text()
    assert '"--isolated"' in unit.read_text()
    assert "EnvironmentFile=" + str(env) in unit.read_text()
    assert 'Environment="PATH=' in unit.read_text()
    assert original.decode().split("=", 1)[1].strip() not in unit.read_text()


def test_supervisor_install_needs_existing_webui_configuration(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    with pytest.raises(ValueError):
        installer.install(tmp_path / "data", 9122, None, "agents", start=False)


def test_unit_arguments_cannot_inject_a_unit_directive():
    with pytest.raises(ValueError):
        installer.unit_arg("name\nExecStart=bad")
    assert "%%" in installer.unit_arg("a%b")
