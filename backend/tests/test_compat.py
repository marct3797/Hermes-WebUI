"""Die Liste der Hermes-Routen in devtools/check_upstream.py muss alles enthalten, was das BFF tatsächlich aufruft."""
import re
from pathlib import Path

from devtools.check_upstream import OWN, USED, LITERAL, missing, normalize, upstream_paths

APP = Path(__file__).resolve().parents[1] / "app"
# Chroma (`knowledge.py`) und die eigenen Dienste sind kein Hermes.
SKIP = {"knowledge.py"}


def prefix(path: str) -> str:
    return normalize(path).split("{", 1)[0].rstrip("/")


def test_every_path_the_bff_calls_is_listed():
    listed = {prefix(p) for paths in USED.values() for p in paths} | {prefix(p) for v in OWN.values() for p in v.split()}
    listed |= {"/api/plugins/kanban", "/api/plugins/hermes-achievements"}  # die Konstante P in routes/kanban.py und routes/achievements.py; die Pfade dahinter stehen unter „kanban-plugin“
    called = {prefix(m.group(1)) for f in APP.rglob("*.py") if f.name not in SKIP
              for line in f.read_text().splitlines() if not line.lstrip().startswith(("#", '"""', "@router", "@app", "@quota_router", "@host_router"))
              for m in LITERAL.finditer(line)}
    assert not called - listed, f"nicht in devtools/check_upstream.py: {sorted(called - listed)}"


def test_checker_finds_listed_paths_in_a_source_tree(tmp_path):
    (tmp_path / "gateway").mkdir()
    (tmp_path / "plugins" / "kanban" / "dashboard").mkdir(parents=True)
    (tmp_path / "plugins" / "kanban" / "dashboard" / "plugin_api.py").write_text('@router.get("/board")\n')
    (tmp_path / "gateway" / "api.py").write_text('ROUTES = [("GET", "/v1/capabilities"), ("POST", f"/v1/runs/{run_id}/stop")]\n')
    assert {"/v1/capabilities", "/v1/runs/{}/stop"} <= upstream_paths(tmp_path)
    gone = missing(tmp_path)
    assert "/v1/capabilities" not in gone["gateway"] and "/v1/runs/{}/stop" not in gone["gateway"]
    assert "/v1/skills" in gone["gateway"]
    assert "/api/plugins/kanban/board" not in gone["kanban-plugin"] and "/api/plugins/kanban/stats" in gone["kanban-plugin"]


def test_coverage_counts_routes_per_module_and_marks_used_ones(tmp_path):
    from devtools.check_upstream import coverage, upstream_routes
    (tmp_path / "hermes_cli" / "web_routers").mkdir(parents=True)
    (tmp_path / "hermes_cli" / "web_routers" / "x.py").write_text('@router.get("/api/skills")\n@router.post("/api/unbekannt")\n@router.get("/kein-api")\n')
    (tmp_path / "gateway" / "platforms").mkdir(parents=True)
    (tmp_path / "gateway" / "platforms" / "api_server.py").write_text('R = [("GET", "/v1/skills"), ("POST", "/v1/nichts")]\n')
    assert len(upstream_routes(tmp_path)) == 4
    cov = coverage(tmp_path)
    assert cov["hermes_cli/web_routers/x.py"] == (2, 1) and cov["gateway/api_server"] == (2, 1)
