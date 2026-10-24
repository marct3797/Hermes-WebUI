"""Ersatz für Host-Dienst (Dateien, Git) und Dashboard (Skill-Text), den die Chat-Eingabe braucht. Nur für Tests und Entwicklung."""
from __future__ import annotations

from fastapi import FastAPI, HTTPException, Query

FILES = {
    "README.md": "# Alpha\nZweite Zeile\nDritte Zeile\n",
    "src/app.py": "print('hallo')\nkey = '«redacted:abcd...wxyz»'\n",
    "big.txt": "x" * 100,
    "src/": None,
}
SKILLS = {"plan": "---\nname: plan\n---\n# Plan\nZerlege die Aufgabe."}


def create_mock(*, repository: bool = True, old_hostd: bool = False) -> FastAPI:
    app = FastAPI()
    app.state.calls = []

    @app.get("/v1/workspaces")
    async def workspaces():
        return {"workspaces": [{"id": "alpha", "label": "Alpha"}]}

    @app.get("/v1/files")
    async def files(workspace: str, path: str = ""):
        app.state.calls.append(("files", workspace, path))
        if workspace != "alpha":
            raise HTTPException(404, "Unknown workspaces")
        if path in ("", "src"):
            prefix = f"{path}/" if path else ""
            names = sorted({k[len(prefix):].split("/")[0] for k in FILES if k.startswith(prefix) and k != prefix})
            return {"workspace": workspace, "path": path, "entries": [
                {"name": n, "path": prefix + n, "kind": "directory" if (prefix + n + "/") in FILES else "file", "size": len(FILES.get(prefix + n) or "")} for n in names]}
        if path.startswith(".") or "secret" in path:
            raise HTTPException(403, "Path denied")
        if path == "bin.dat":
            raise HTTPException(415, "Binary preview unavailable")
        if path == "huge.txt":
            return {"workspace": workspace, "path": path, "content": "x" * 10, "truncated": True}
        if FILES.get(path) is None:
            raise HTTPException(404, "File not found")
        return {"workspace": workspace, "path": path, "content": FILES[path], "truncated": False}

    @app.get("/v1/git")
    async def git(workspace: str, mode: str = "all", n: int = Query(1, ge=1, le=10)):
        app.state.calls.append(("git", workspace, mode, n))
        if not repository:
            return {"repository": False, "reason": "Kein Git-Repository in diesem Arbeitsordner"}
        out = {"branch": "main", "status": "", "remotes": [], "truncated": False}
        if not old_hostd:
            out["mode"] = mode
        if mode == "log":
            return {**out, "log": f"abc1234 2026-01-01 Erster Stand (n={n})"}
        return {**out, "diff": {"staged": "+staged-zeile", "diff": "+offene-zeile"}.get(mode, "+alles")}

    @app.get("/api/skills/content")
    async def skill(name: str, profile: str | None = None):
        if name not in SKILLS:
            raise HTTPException(404, "Skill not found")
        return {"name": name, "content": SKILLS[name], "path": f"{name}/SKILL.md"}

    return app
