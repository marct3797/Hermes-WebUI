"""Prüft, ob jede Hermes-Route, die die WebUI aufruft, im Quelltext einer Hermes-Installation vorkommt.

    python -m devtools.check_upstream /pfad/zu/hermes-agent              # Exit 0 = alle genutzten Pfade vorhanden
    python -m devtools.check_upstream /pfad/zu/hermes-agent --coverage   # welcher Teil der Hermes-Routen ist abgebildet

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
        "/api/tools/toolsets", "/api/tools/toolsets/{}", "/api/tools/toolsets/{}/config", "/api/tools/toolsets/{}/provider",
        "/api/tools/toolsets/{}/env", "/api/tools/toolsets/{}/models", "/api/tools/toolsets/{}/model", "/api/tools/terminal/backends",
        "/api/status", "/api/messaging/platforms", "/api/messaging/platforms/{}", "/api/messaging/platforms/{}/test", "/api/messaging/telegram/onboarding/start",
        "/api/messaging/telegram/onboarding/{}", "/api/messaging/telegram/onboarding/{}/apply", "/api/gateway/start", "/api/gateway/stop", "/api/gateway/restart",
        "/api/actions/{}/status", "/api/health", "/api/hermes/update/check", "/api/ops/doctor", "/api/ops/backup", "/api/profiles/active", "/api/profiles/import", "/api/profiles/{}/setup-command", "/api/memory", "/api/memory/provider", "/api/memory/reset", "/api/memory/providers/{}/config", "/api/mcp/servers", "/api/mcp/catalog", "/api/mcp/catalog/install", "/api/dashboard/plugins/hub",
        "/api/dashboard/plugins/catalog", "/api/dashboard/agent-plugins/install",
        "/api/cron/jobs", "/api/cron/jobs/{}", "/api/cron/jobs/{}/runs", "/api/cron/jobs/{}/pause", "/api/cron/jobs/{}/resume",
        "/api/cron/jobs/{}/trigger", "/api/cron/delivery-targets", "/api/cron/blueprints", "/api/cron/blueprints/instantiate",
        "/api/model/info", "/api/model/recommended-default", "/api/model/auxiliary", "/api/model/moa", "/api/model/set",
        "/api/delegation/routing", "/api/delegation/backend", "/api/providers/custom-endpoints", "/api/providers/custom-endpoints/{}/activate", "/api/providers/custom-endpoints/{}", "/api/providers/custom-endpoints/validate", "/api/local-models/status",
        "/api/sessions/stats", "/api/sessions/empty/count", "/api/sessions/empty", "/api/sessions/prune", "/api/sessions/bulk-delete", "/api/sessions/{}/export",
        "/api/pairing", "/api/pairing/approve", "/api/pairing/revoke", "/api/webhooks", "/api/webhooks/enable", "/api/webhooks/{}", "/api/webhooks/{}/enabled",
        "/api/credentials/pool", "/api/credentials/pool/{}/{}", "/api/audio/voice-live/status", "/api/audio/speak", "/api/audio/transcribe",
        "/api/system/stats", "/api/curator", "/api/curator/paused", "/api/curator/run", "/api/learning/graph", "/api/learning/node",
        "/api/dashboard/themes", "/api/dashboard/theme", "/api/dashboard/font", "/api/egress/status", "/api/shared-metrics/consent",
        "/api/mcp/servers/{}", "/api/mcp/servers/{}/test", "/api/mcp/servers/{}/auth", "/api/mcp/servers/{}/enabled", "/api/mcp/oauth/flows/{}",
        "/api/dashboard/agent-plugins/{}", "/api/dashboard/agent-plugins/{}/enable", "/api/dashboard/agent-plugins/{}/disable", "/api/dashboard/agent-plugins/{}/update",
    ],
    "achievements-plugin": ["/api/plugins/hermes-achievements/achievements", "/api/plugins/hermes-achievements/rescan", "/api/plugins/hermes-achievements/reset-state"],  # plugins/hermes-achievements/dashboard/plugin_api.py
    "kanban-plugin": [  # liegt Hermes bei: plugins/kanban/dashboard/plugin_api.py, eingehängt unter /api/plugins/kanban
        "/api/plugins/kanban/board", "/api/plugins/kanban/boards", "/api/plugins/kanban/boards/{}", "/api/plugins/kanban/stats", "/api/plugins/kanban/assignees",
        "/api/plugins/kanban/tasks", "/api/plugins/kanban/tasks/bulk", "/api/plugins/kanban/tasks/{}", "/api/plugins/kanban/tasks/{}/log",
        "/api/plugins/kanban/tasks/{}/comments", "/api/plugins/kanban/tasks/{}/reassign", "/api/plugins/kanban/tasks/{}/reclaim", "/api/plugins/kanban/links",
        "/api/plugins/kanban/diagnostics", "/api/plugins/kanban/workers/active", "/api/plugins/kanban/runs/{}", "/api/plugins/kanban/runs/{}/inspect", "/api/plugins/kanban/runs/{}/terminate", "/api/plugins/kanban/tasks/{}/specify", "/api/plugins/kanban/tasks/{}/estimate", "/api/plugins/kanban/dispatch", "/api/plugins/kanban/boards/{}/switch",
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


ROUTE = re.compile(r"""@(\w+)\.(get|post|put|patch|delete|websocket)\(\s*f?["'](/[^"']*)["']""")
TUPLE = re.compile(r"""\(\s*["'](GET|POST|PUT|PATCH|DELETE)["']\s*,\s*f?["'](/(?:v1|api)/[^"']*)["']""")


def upstream_routes(root: Path) -> set[tuple[str, str, str]]:
    """Alle Routen (Modul, Methode, Pfad), die Dashboard-Router, Plugins und der Gateway-API-Server anbieten."""
    found: set[tuple[str, str, str]] = set()
    for f in (root / "hermes_cli").rglob("*.py") if (root / "hermes_cli").is_dir() else []:
        if "tests" in f.parts:
            continue
        for m in ROUTE.finditer(f.read_text(errors="ignore")):
            if m.group(3).startswith(("/api/", "/v1/")):
                found.add((f.relative_to(root).as_posix(), m.group(2).upper(), normalize(m.group(3))))
    for f in root.glob("plugins/*/dashboard/plugin_api.py"):
        name = f.parent.parent.name
        for m in ROUTE.finditer(f.read_text(errors="ignore")):
            found.add((f"plugins/{name}", m.group(2).upper(), normalize(f"/api/plugins/{name}{m.group(3)}")))
    for f in root.glob("gateway/platforms/api_server*.py"):
        for m in TUPLE.finditer(f.read_text(errors="ignore")):
            found.add(("gateway/api_server", m.group(1), normalize(m.group(2))))
    return found


def coverage(root: Path) -> dict[str, tuple[int, int]]:
    """Modul -> (Routen, davon vom BFF genutzt; pfadgenau, ohne Methode)."""
    used = {normalize(p) for paths in USED.values() for p in paths}
    out: dict[str, list[int]] = {}
    for module, _, path in upstream_routes(root):
        row = out.setdefault(module, [0, 0])
        row[0] += 1
        row[1] += path in used
    return {m: (a, b) for m, (a, b) in out.items()}


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 1 or not Path(args[0]).is_dir():
        sys.exit(__doc__)
    if "--coverage" in sys.argv:
        rows = sorted(coverage(Path(args[0])).items(), key=lambda kv: (kv[1][1] / kv[1][0], -kv[1][0]))
        print(f"{'Modul':50} {'Routen':>6} {'genutzt':>7}")
        for module, (total, used_) in rows:
            print(f"{module:50} {total:6} {used_:7}")
        print(f"{'GESAMT':50} {sum(t for t, _ in dict(rows).values()):6} {sum(u for _, u in dict(rows).values()):7}")
        sys.exit(0)
    gone = missing(Path(args[0]))
    for comp, paths in USED.items():
        print(f"{comp}: {len(paths) - len(gone[comp])}/{len(paths)} gefunden")
        for p in gone[comp]:
            print(f"  FEHLT {p}")
    sys.exit(1 if any(gone.values()) else 0)
