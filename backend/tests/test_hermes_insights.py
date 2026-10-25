"""P3: System, Curator, Lerngraph, Darstellung, Datenschutz (Metriken, Egress) und Achievements.

Schranken des BFF:
- System: nur Kennzahlen, nie Umgebungs-/Pfad-/Schlüsselfelder,
- Curator: Pausieren frisch; Starten schreibt Skills um/archiviert sie: frisch + `confirm_archive` + Rate-Limit,
- Lerngraph: Bearbeiten frisch, Löschen frisch + eingetippte Knoten-ID, ID-Muster ohne `..`, Inhalt begrenzt, Graph begrenzt,
- Darstellung: Theme nur aus der gemeldeten Liste, Schrift nur aus der Allowlist (Hermes lädt Schriften per URL nach),
- Metriken-Einwilligung: Ändern frisch, Senden von Nutzungsdaten nur mit `confirm_send`, verwaltete Installationen nie,
- Achievements: Neu scannen frisch + Rate-Limit, Zurücksetzen frisch + eingetipptes „reset“, Antworten schlank.
"""
import pytest

from tests.denv import BASE, client, fresh, stale

S = BASE


@pytest.fixture
def env(tmp_path, make_settings):
    yield from client(tmp_path, make_settings)


@pytest.fixture
def lossy(tmp_path, make_settings):
    yield from client(tmp_path, make_settings, drop_writes=True)


# ---- System ----
def test_system_shows_figures_but_no_env_path_or_key_fields(env):
    r = env.get(f"{S}/hermes-system")
    assert r.status_code == 200 and r.json()["hermes_version"] and r.json()["cpu_count"] >= 1
    assert "sk-LEAK" not in r.text and "env" not in r.json() and "home" not in r.json()


# ---- Computer Use (nur Status; Rechte vergibt die WebUI nie) ----
def test_computer_use_status_is_read_only_and_slim(env):
    r = env.get(f"{S}/hermes-computer-use")
    assert r.status_code == 200 and r.json()["installed"] is True and r.json()["ready"] is True and r.json()["platform"] == "linux"
    assert [c["name"] for c in r.json()["checks"]] == ["driver"] and "sk-LEAK" not in r.text and "/home/someone" not in r.text
    assert env.post(f"{S}/hermes-computer-use/grant").status_code in (404, 405)  # keine Rechte-Vergabe


def test_computer_use_status_with_wrong_shape_is_502(env):
    for bad in (True, "checks"):
        env.dash.state.profiles["default"]["cu_bad"] = bad
        assert env.get(f"{S}/hermes-computer-use").status_code == 502


# ---- Curator ----
def test_curator_status_then_pause_needs_fresh_and_reads_back(env):
    assert env.get(f"{S}/hermes-curator").json()["paused"] is False
    stale(env)
    assert env.put(f"{S}/hermes-curator/paused", json={"paused": True}).status_code == 401
    fresh(env)
    assert env.put(f"{S}/hermes-curator/paused", json={"paused": True}).status_code == 200
    assert env.get(f"{S}/hermes-curator").json()["paused"] is True


def test_curator_pause_that_the_dashboard_only_pretends_is_a_502(lossy):
    assert lossy.put(f"{S}/hermes-curator/paused", json={"paused": True}).status_code == 502


def test_curator_run_needs_fresh_and_explicit_confirmation(env):
    stale(env)
    assert env.post(f"{S}/hermes-curator/run", json={"confirm_archive": True}).status_code == 401
    fresh(env)
    assert env.post(f"{S}/hermes-curator/run", json={}).status_code == 422
    assert env.post(f"{S}/hermes-curator/run", json={"confirm_archive": False}).status_code == 422
    r = env.post(f"{S}/hermes-curator/run", json={"confirm_archive": True})
    assert r.status_code == 200 and r.json()["started"] is True
    log = env.get(f"{S}/hermes-curator/run")
    assert log.status_code == 200 and "Curator fertig" in log.text and "Bearer sk-" not in log.text


# ---- Lerngraph ----
def test_learning_graph_is_capped_and_slim(env):
    r = env.get(f"{S}/hermes-learning")
    assert r.status_code == 200 and {n["id"] for n in r.json()["nodes"]} >= {"skill-a", "memory:memory:0:aaaaaaaaaaaa"} and r.json()["edges"]
    assert "path" not in r.text
    env.dash.state.profiles["default"]["graph_n"] = 700
    assert len(env.get(f"{S}/hermes-learning").json()["nodes"]) == 500


@pytest.mark.parametrize("nid", ["../x", "a/../b", "", "x" * 201, "a\nb"])
def test_learning_node_ids_are_validated(env, nid):
    assert env.get(f"{S}/hermes-learning/node", params={"id": nid}).status_code == 422


def test_learning_node_read_edit_delete_guards(env):
    n = env.get(f"{S}/hermes-learning/node", params={"id": "skill-a"})
    assert n.status_code == 200 and n.json()["content"].startswith("# Skill A")
    assert env.get(f"{S}/hermes-learning/node", params={"id": "gibtsnicht"}).status_code == 404
    stale(env)
    assert env.put(f"{S}/hermes-learning/node", json={"id": "skill-a", "content": "# neu"}).status_code == 401
    fresh(env)
    assert env.put(f"{S}/hermes-learning/node", json={"id": "skill-a", "content": "x" * 100_001}).status_code == 422
    assert env.put(f"{S}/hermes-learning/node", json={"id": "skill-a", "content": "   "}).status_code == 422
    assert env.put(f"{S}/hermes-learning/node", json={"id": "skill-a", "content": "# Skill A neu"}).status_code == 200
    assert env.get(f"{S}/hermes-learning/node", params={"id": "skill-a"}).json()["content"] == "# Skill A neu"
    stale(env)
    assert env.request("DELETE", f"{S}/hermes-learning/node", params={"id": "skill-a", "confirm": "skill-a"}).status_code == 401
    fresh(env)
    assert env.request("DELETE", f"{S}/hermes-learning/node", params={"id": "skill-a", "confirm": "falsch"}).status_code == 422
    assert env.request("DELETE", f"{S}/hermes-learning/node", params={"id": "skill-a"}).status_code == 422
    assert env.request("DELETE", f"{S}/hermes-learning/node", params={"id": "skill-a", "confirm": "skill-a"}).status_code == 200
    assert env.get(f"{S}/hermes-learning/node", params={"id": "skill-a"}).status_code == 404


def _memory_id(env):
    return next(n["id"] for n in env.get(f"{S}/hermes-learning").json()["nodes"] if n["id"].startswith("memory:"))


def test_editing_a_memory_node_follows_its_new_id(env):
    # Hermes: die ID einer Erinnerung enthält den Fingerabdruck ihres Textes und ändert sich mit ihm (live gemessen)
    old = _memory_id(env)
    r = env.put(f"{S}/hermes-learning/node", json={"id": old, "content": "Neuer Text"})
    assert r.status_code == 200 and r.json()["id"] != old and r.json()["id"].startswith("memory:memory:0:")
    assert env.get(f"{S}/hermes-learning/node", params={"id": r.json()["id"]}).json()["content"] == "Neuer Text"
    assert env.get(f"{S}/hermes-learning/node", params={"id": old}).status_code == 404


def test_a_memory_edit_that_is_dropped_is_502(lossy):
    assert lossy.put(f"{S}/hermes-learning/node", json={"id": _memory_id(lossy), "content": "Neuer Text"}).status_code == 502


def test_a_memory_that_vanishes_after_saving_is_a_502_not_a_404(env):
    env.dash.state.profiles["default"]["vanish"] = True
    assert env.put(f"{S}/hermes-learning/node", json={"id": _memory_id(env), "content": "Neuer Text"}).status_code == 502


def test_learning_edit_and_delete_that_are_dropped_are_502(lossy):
    assert lossy.put(f"{S}/hermes-learning/node", json={"id": "skill-a", "content": "# neu"}).status_code == 502
    assert lossy.request("DELETE", f"{S}/hermes-learning/node", params={"id": "skill-a", "confirm": "skill-a"}).status_code == 502


# ---- Darstellung ----
def test_appearance_theme_and_font_only_from_the_allowed_lists(env):
    a = env.get(f"{S}/hermes-appearance").json()
    assert a["active"] == "default" and {t["name"] for t in a["themes"]} >= {"default", "midnight"} and a["font"] == "theme" and "inter" in a["fonts"]
    stale(env)
    assert env.put(f"{S}/hermes-appearance/theme", json={"name": "midnight"}).status_code == 401
    fresh(env)
    assert env.put(f"{S}/hermes-appearance/theme", json={"name": "erfunden"}).status_code == 422
    assert env.put(f"{S}/hermes-appearance/theme", json={"name": "midnight"}).status_code == 200
    assert env.put(f"{S}/hermes-appearance/font", json={"font": "https://evil.test/x.css"}).status_code == 422
    assert env.put(f"{S}/hermes-appearance/font", json={"font": "inter"}).status_code == 200
    b = env.get(f"{S}/hermes-appearance").json()
    assert b["active"] == "midnight" and b["font"] == "inter"


def test_appearance_writes_that_are_dropped_are_502(lossy):
    assert lossy.put(f"{S}/hermes-appearance/theme", json={"name": "midnight"}).status_code == 502
    assert lossy.put(f"{S}/hermes-appearance/font", json={"font": "inter"}).status_code == 502


# ---- Datenschutz ----
def test_privacy_shows_egress_text_and_consent(env):
    p = env.get(f"{S}/hermes-privacy").json()
    assert p["egress"].startswith("Egress-Proxy") and p["metrics"] == {"enabled": False, "send": False, "decided": False, "managed": False}
    assert "sk-LEAK" not in str(p)


def test_metrics_consent_needs_fresh_and_confirm_send_and_never_on_managed_installs(env):
    stale(env)
    assert env.put(f"{S}/hermes-privacy/metrics", json={"enabled": True, "send": False}).status_code == 401
    fresh(env)
    assert env.put(f"{S}/hermes-privacy/metrics", json={"enabled": True, "send": True}).status_code == 422  # Daten verlassen den Rechner
    assert env.put(f"{S}/hermes-privacy/metrics", json={"enabled": False, "send": True, "confirm_send": True}).status_code == 422  # senden ohne zu sammeln
    assert env.put(f"{S}/hermes-privacy/metrics", json={"enabled": True, "send": True, "confirm_send": True}).status_code == 200
    assert env.get(f"{S}/hermes-privacy").json()["metrics"]["send"] is True
    env.dash.state.profiles["default"]["managed"] = True
    assert env.put(f"{S}/hermes-privacy/metrics", json={"enabled": False, "send": False}).status_code == 409


def test_metrics_write_that_is_dropped_is_502(lossy):
    assert lossy.put(f"{S}/hermes-privacy/metrics", json={"enabled": True, "send": False}).status_code == 502


# ---- Achievements (Host-Ebene: das Plugin gehört dem Dashboard) ----
A = "/bff/h/server/_achievements"


def test_achievements_list_is_slim_and_hides_secret_names(env):
    env.dash.state.ach_leaky = True  # ein Dashboard, das den Geheimnamen doch mitschickt: das BFF maskiert selbst
    r = env.get(A)
    assert r.status_code == 200 and r.json()["total"] == 3 and r.json()["unlocked"] == 1
    secret = next(a for a in r.json()["items"] if a["state"] == "secret")
    assert secret["name"] == "???" and "criteria" not in secret and "Echter Geheimname" not in r.text and "100 Fehler" not in r.text and "geheim" not in r.text  # auch das Kriterium bleibt verborgen
    assert "sk-LEAK" not in r.text and "sessions" not in r.json()


def test_achievements_rescan_and_reset_guards(env):
    stale(env)
    assert env.post(f"{A}/rescan").status_code == 401
    fresh(env)
    assert env.post(f"{A}/rescan").status_code == 200
    assert env.post(f"{A}/reset", json={"confirm": "falsch"}).status_code == 422
    assert env.post(f"{A}/reset", json={}).status_code == 422
    stale(env)
    assert env.post(f"{A}/reset", json={"confirm": "reset"}).status_code == 401
    fresh(env)
    assert env.get(A).json()["unlocked"] == 1
    assert env.post(f"{A}/reset", json={"confirm": "reset"}).status_code == 200
    assert env.get(A).json()["unlocked"] == 0


def test_achievements_reset_that_is_dropped_is_502(lossy):
    assert lossy.post(f"{A}/reset", json={"confirm": "reset"}).status_code == 502
