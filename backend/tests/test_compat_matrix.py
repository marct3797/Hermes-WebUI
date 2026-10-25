import subprocess
from pathlib import Path

from devtools.compat_matrix import first_complete, matrix, report


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@invalid", *args], check=True, capture_output=True)


def _repo(tmp_path: Path) -> Path:
    repo = tmp_path / "hermes"
    (repo / "gateway").mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    api = repo / "gateway" / "api.py"
    api.write_text('ROUTES = [("GET", "/v1/capabilities")]\n')
    _git(repo, "add", "-A"); _git(repo, "commit", "-qm", "alt"); _git(repo, "tag", "v1")
    api.write_text('ROUTES = [("GET", "/v1/capabilities"), ("POST", f"/v1/runs/{run_id}/stop")]\n')
    _git(repo, "add", "-A"); _git(repo, "commit", "-qm", "neu"); _git(repo, "tag", "v2")
    return repo


def test_a_path_missing_in_an_older_version_is_reported_with_the_versions_it_is_missing_in(tmp_path):
    repo = _repo(tmp_path)
    m = matrix(repo, ["v1", "v2"])
    assert "gateway: /v1/runs/{}/stop" not in m["v2"] and "gateway: /v1/runs/{}/stop" in m["v1"]
    assert len(m["v1"]) == len(m["v2"]) + 1  # nur dieser eine Pfad unterscheidet die Stände


def test_older_trees_without_every_folder_do_not_break_the_check(tmp_path):
    repo = _repo(tmp_path)  # es gibt weder hermes_cli noch plugins: die Ordner fehlen einfach
    assert matrix(repo, ["v1"])["v1"]


def test_first_complete_requires_every_later_version_to_be_complete():
    m = {"a": {"x"}, "b": set(), "c": {"y"}, "d": set()}
    assert first_complete(m, ["a", "b", "c", "d"]) == "d"  # b war vollständig, aber c nicht: erst ab d durchgehend
    assert first_complete({"a": {"x"}}, ["a"]) is None


def test_report_names_the_path_and_where_it_is_missing():
    text = report({"v1": {"gateway: /v1/x"}, "v2": {"gateway: /v1/x"}, "v3": set()}, ["v1", "v2", "v3"])
    assert "gateway: /v1/x: fehlt in v1 bis v2 (2 von 3)" in text and "Ab v3 sind alle genutzten Pfade vorhanden." in text
