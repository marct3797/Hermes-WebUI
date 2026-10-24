"""Prüft, ob jede Hermes-Route, die die WebUI aufruft, im Quelltext einer Hermes-Installation vorkommt.

    python -m devtools.check_upstream /pfad/zu/hermes-agent

Das belegt nur, dass der Pfad existiert, nicht dass Anfrage und Antwort dieselbe Form haben (das prüfen die Vertragstests, siehe
docs/contract-tests.md). Die Liste unten ist die einzige Quelle für docs/compatibility.md; `tests/test_compat.py` hält sie vollständig.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

# Komponente -> Pfade, wie die WebUI sie aufruft ({} steht für einen Parameter)
USED: dict[str, list[str]] = {
    "gateway": [  # API-Server jedes Agents (gateway/platforms/api_server*.py)
        "/v1/capabilities", "/v1/runs", "/v1/runs/{}", "/v1/runs/{}/events", "/v1/runs/{}/approval", "/v1/runs/{}/clarify", "/v1/runs/{}/steer",
        "/v1/runs/{}/stop", "/v1/skills", "/v1/toolsets", "/api/sessions", "/api/sessions/{}", "/api/sessions/{}/messages", "/api/sessions/{}/fork",
        "/api/model/options", "/api/jobs",
    ],
    "dashboard": [  # `hermes dashboard` (hermes_cli/web_routers, web_server*.py)
        "/api/profiles", "/api/profiles/{}/soul", "/api/profiles/{}/description", "/api/profiles/{}/model", "/api/config", "/api/config/schema",
        "/api/env", "/api/providers/oauth", "/api/providers/validate", "/api/providers/oauth/{}/start", "/api/providers/oauth/{}/poll/{}",
        "/api/providers/oauth/{}/submit", "/api/providers/oauth/sessions/{}", "/api/analytics/models", "/api/model/options", "/api/sessions/search", "/api/logs",
        "/api/skills", "/api/skills/toggle", "/api/skills/content", "/api/skills/hub/search", "/api/skills/hub/sources", "/api/skills/hub/official",
        "/api/skills/hub/preview", "/api/skills/hub/scan", "/api/skills/hub/install", "/api/skills/hub/update", "/api/skills/hub/uninstall",
        "/api/tools/toolsets", "/api/mcp/servers", "/api/mcp/catalog", "/api/mcp/catalog/install", "/api/dashboard/plugins/hub",
        "/api/dashboard/plugins/catalog", "/api/dashboard/agent-plugins/install",
        "/api/cron/jobs", "/api/cron/jobs/{}", "/api/cron/jobs/{}/runs", "/api/cron/jobs/{}/pause", "/api/cron/jobs/{}/resume",
        "/api/cron/jobs/{}/trigger", "/api/cron/delivery-targets", "/api/cron/blueprints", "/api/cron/blueprints/instantiate",
    ],
    "kanban-plugin": [  # liegt Hermes bei: plugins/kanban/dashboard/plugin_api.py, eingehängt unter /api/plugins/kanban
        "/api/plugins/kanban/board", "/api/plugins/kanban/boards", "/api/plugins/kanban/boards/{}", "/api/plugins/kanban/stats", "/api/plugins/kanban/assignees",
        "/api/plugins/kanban/tasks", "/api/plugins/kanban/tasks/bulk", "/api/plugins/kanban/tasks/{}", "/api/plugins/kanban/tasks/{}/log",
        "/api/plugins/kanban/tasks/{}/comments", "/api/plugins/kanban/tasks/{}/reassign", "/api/plugins/kanban/tasks/{}/reclaim", "/api/plugins/kanban/links",
    ],
}
# Nicht Teil von Hermes: kommen aus diesem Repo (hostd, Kontingent-Plugin) und werden hier nicht gegen Hermes geprüft.
OWN = {"hostd": "/v1/info /v1/auth /v1/terminals /v1/workspaces /v1/files /v1/files/write /v1/files/mkdir /v1/files/move /v1/files/download /v1/files/upload /v1/git /v1/search /v1/manage", "quota-plugin": "/api/plugins/ai-usage-tracker/usage"}

LITERAL = re.compile(r"""["'](/(?:api|v1)/[^"'\s]*)["']""")


def normalize(path: str) -> str:
    return re.sub(r"\{[^}]*\}", "{}", path).rstrip("/")


PLUGIN_ROUTE = re.compile(r"""@router\.\w+\(\s*["'](/[^"']*)["']""")


def upstream_paths(root: Path) -> set[str]:
    found: set[str] = set()
    for f in root.rglob("*.py"):
        if {"tests", "node_modules", "venv", ".venv", "site-packages"} & set(f.parts):
            continue
        text = f.read_text(errors="ignore")
        found.update(normalize(m.group(1)) for m in LITERAL.finditer(text))
        if f.name == "plugin_api.py" and f.parent.name == "dashboard":  # Plugin-Routen stehen relativ im Quelltext
            found.update(normalize(f"/api/plugins/{f.parent.parent.name}{m.group(1)}") for m in PLUGIN_ROUTE.finditer(text))
    return found


def missing(root: Path) -> dict[str, list[str]]:
    have = upstream_paths(root)
    return {c: [p for p in paths if p not in have] for c, paths in USED.items()}


if __name__ == "__main__":
    if len(sys.argv) != 2 or not Path(sys.argv[1]).is_dir():
        sys.exit(__doc__)
    gone = missing(Path(sys.argv[1]))
    for comp, paths in USED.items():
        print(f"{comp}: {len(paths) - len(gone[comp])}/{len(paths)} gefunden")
        for p in gone[comp]:
            print(f"  FEHLT {p}")
    sys.exit(1 if any(gone.values()) else 0)
