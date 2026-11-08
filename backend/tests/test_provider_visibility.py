import pytest

from app.config import Settings
from app.providers import build_overview, normalize_models
from app.quota import normalize

IDS = ("nous", "opencode-zen", "opencode-go")
ENV = {f"KEY_{i}": {"provider": i, "is_set": True} for i in IDS}
OAUTH = {"providers": [{"id": i} for i in IDS]}
ANALYTICS = {"models": [{"provider": i, "sessions": 1} for i in IDS]}
OPTIONS = {"providers": [{"slug": i, "models": ["model"]} for i in IDS]}
QUOTA = {"providers": [{"id": i, "name": i} for i in IDS]}


def test_all_providers_are_shown_by_default():
    """Eine öffentliche Installation filtert nichts: die Sichtbarkeit ist Sache des Betreibers."""
    assert sorted(p["id"] for p in build_overview(ENV, OAUTH, ANALYTICS, 30)["providers"]) == sorted(IDS)
    assert sorted(p["slug"] for p in normalize_models(OPTIONS)) == sorted(IDS)
    assert sorted(p["id"] for p in normalize(QUOTA)["providers"]) == sorted(IDS)


def test_operator_can_hide_providers_in_every_source():
    hidden = frozenset({"nous", "opencode-zen"})
    assert [p["id"] for p in build_overview(ENV, OAUTH, ANALYTICS, 30, hidden)["providers"]] == ["opencode-go"]
    assert [p["slug"] for p in normalize_models(OPTIONS, hidden)] == ["opencode-go"]
    assert [p["id"] for p in normalize(QUOTA, hidden=hidden)["providers"]] == ["opencode-go"]


@pytest.mark.parametrize("raw,expected", [("", set()), ("nous", {"nous"}), (" Nous , opencode-zen,, ", {"nous", "opencode-zen"})])
def test_setting_is_a_comma_list(monkeypatch, raw, expected):
    monkeypatch.setenv("HERMES_WEBUI_HIDDEN_PROVIDERS", raw)
    assert Settings().hidden_provider_set() == frozenset(expected)
