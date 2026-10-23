import importlib.util
from pathlib import Path
import pytest

spec = importlib.util.spec_from_file_location("supervisor", Path(__file__).parents[2] / "deploy/dashboard_supervisor.py")
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_supervisor_keeps_credentials_out_of_argv_and_adopts_healthy_dashboard(tmp_path, monkeypatch):
    (tmp_path / "webui.env").write_text("# comment\nUNRELATED=ignored\nHERMES_DASHBOARD_TOKEN=" + "x" * 48 + "\n")
    checks = iter([True, False, True])
    monkeypatch.setattr(module, "healthy", lambda *_: next(checks))
    calls = []
    class Child:
        def poll(self): return None
        def terminate(self): pass
        def wait(self, timeout): pass
    monkeypatch.setattr(module.subprocess, "Popen", lambda argv, **kwargs: calls.append((argv, kwargs)) or Child())
    monkeypatch.setattr(module.time, "sleep", lambda _: None)
    with pytest.raises(StopIteration):
        module.supervise(tmp_path, "test-container", 9122)
    assert len(calls) == 1
    argv, kwargs = calls[0]
    assert "x" * 48 not in " ".join(argv)
    assert kwargs["env"]["HERMES_DASHBOARD_SESSION_TOKEN"] == "x" * 48
    assert "-d" not in argv
    assert argv[-1] == "--skip-build"


def test_supervisor_rejects_absent_token(tmp_path):
    (tmp_path / "webui.env").write_text("OTHER=value\n")
    with pytest.raises(ValueError):
        module.read_token(tmp_path / "webui.env")
