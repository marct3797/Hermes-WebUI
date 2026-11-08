"""hostd verweigert root (create_app). Läuft die Testsuite trotzdem als root (Container), tun die Tests so, als wäre es ein normaler Nutzer.
Tests, die die Root-Ablehnung prüfen, setzen geteuid selbst und gewinnen, weil sie nach dieser Fixture patchen."""
import os

import pytest


@pytest.fixture(autouse=True)
def _not_root(monkeypatch):
    if os.geteuid() == 0:
        monkeypatch.setattr(os, "geteuid", lambda: 1000)
