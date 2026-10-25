"""Ältere Hermes-Versionen kennen manche Routen nicht (Matrix: docs/compatibility.md). Das muss die Person lesen können, statt „404“ oder „502“ zu sehen."""
import pytest

from tests.denv import BASE, client

S = BASE


@pytest.fixture
def env(tmp_path, make_settings):
    yield from client(tmp_path, make_settings)


def test_a_route_this_hermes_version_lacks_is_a_501_that_names_it(env):
    env.dash.state.hidden = {"/api/delegation/routing"}
    r = env.get(f"{S}/hermes-delegation")
    assert r.status_code == 501
    assert "Hermes" in r.json()["detail"] and "/api/delegation/routing" in r.json()["detail"] and "aktualisieren" in r.json()["detail"]


def test_a_missing_resource_stays_a_404_with_its_own_text(env):
    r = env.get(f"{S}/hermes-learning/node", params={"id": "gibtsnicht"})
    assert r.status_code == 404 and "Hermes-Version" not in r.json()["detail"]


def test_a_missing_plugin_route_is_still_reported_as_a_missing_plugin(env):
    env.dash.state.hidden = {"/api/plugins/kanban/board"}
    r = env.get("/bff/h/server/_kanban/board")
    assert r.status_code == 404 and "Kanban" in r.json()["detail"]


def test_other_features_of_the_same_version_keep_working(env):
    env.dash.state.hidden = {"/api/delegation/routing"}
    assert env.get(f"{S}/hermes-delegation").status_code == 501
    assert env.get(f"{S}/hermes-system").status_code == 200
