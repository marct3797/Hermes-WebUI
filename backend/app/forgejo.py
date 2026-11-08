"""Forgejo-Issues als eigenes Board im Kanban-Modul (getrennt vom Hermes-Kanban).

Konfiguration `forgejo.json` (siehe forgejo.example.json): Instanzen mit Basis-URL, dem NAMEN einer Umgebungsvariable für den API-Token
(`token_env`, der Token selbst steht nie in der Datei, nie in Antworten) und einer Liste erlaubter Repos `owner/name`.
Spalten: `open`, danach je ein Eintrag aus `progress_labels` (Label am offenen Issue), zuletzt `closed`.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

import httpx

from .adapters import UpstreamError

ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$")
ENV_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
LABEL_RE = re.compile(r"^[^\x00-\x1f\x7f]{1,100}$")
PAGE = 50
MAX_PAGES = 6  # höchstens 300 Issues je Repo und Abruf
SNIPPET = 160


@dataclass(frozen=True)
class ForgejoCfg:
    id: str
    label: str
    base_url: str
    token_env: str
    repos: tuple[str, ...]
    progress_labels: tuple[str, ...] = field(default_factory=tuple)

    @property
    def columns(self) -> list[str]:
        return ["open", *self.progress_labels, "closed"]


def parse_forgejo_config(raw: Any) -> dict[str, ForgejoCfg]:
    if not isinstance(raw, dict) or not isinstance(raw.get("instances"), list):
        raise ValueError('erwartet {"instances": [...]}')
    out: dict[str, ForgejoCfg] = {}
    for p in raw["instances"]:
        if not isinstance(p, dict):
            raise ValueError("Eintrag ist kein Objekt")
        iid = str(p.get("id", ""))
        if not ID_RE.match(iid):
            raise ValueError(f"ungültige id {iid!r}")
        if iid in out:
            raise ValueError(f"id {iid!r} doppelt")
        url = str(p.get("base_url") or "").rstrip("/")
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
            raise ValueError(f"{iid}: base_url muss http(s) ohne Zugangsdaten sein")
        env = str(p.get("token_env") or "")
        if not ENV_RE.match(env):
            raise ValueError(f"{iid}: token_env muss der Name einer Umgebungsvariable sein (nicht der Token selbst)")
        repos = p.get("repos")
        if not isinstance(repos, list) or not repos or not all(isinstance(r, str) and REPO_RE.match(r) and ".." not in r for r in repos):
            raise ValueError(f"{iid}: repos braucht mindestens ein Repo der Form owner/name")
        labels = p.get("progress_labels", [])
        if not isinstance(labels, list) or len(labels) > 6 or not all(isinstance(x, str) and LABEL_RE.match(x) and x not in ("open", "closed") for x in labels) or len(set(labels)) != len(labels):
            raise ValueError(f"{iid}: progress_labels ist eine Liste von höchstens 6 verschiedenen Label-Namen")
        out[iid] = ForgejoCfg(iid, str(p.get("label") or iid), url, env, tuple(dict.fromkeys(repos)), tuple(labels))
    return out


class ForgejoRegistry:
    """`forgejo.json`, bei Änderung ohne Neustart neu gelesen. Fehlt die Datei, gibt es keine Instanzen."""

    def __init__(self, path: Path | None):
        self.path = path
        self.error: str | None = None
        self._mtime: float | None = None
        self._cfg: dict[str, ForgejoCfg] = {}

    def instances(self) -> dict[str, ForgejoCfg]:
        if self.path is None:
            return {}
        try:
            mtime = self.path.stat().st_mtime
        except FileNotFoundError:
            self._cfg, self._mtime, self.error = {}, None, None
            return self._cfg
        if mtime != self._mtime:
            self._mtime = mtime
            try:
                self._cfg = parse_forgejo_config(json.loads(self.path.read_text("utf-8")))
                self.error = None
            except (ValueError, OSError) as e:
                self.error = f"forgejo.json: {e}"  # die letzte gültige Fassung bleibt
        return self._cfg


def column_of(issue: dict[str, Any], cfg: ForgejoCfg) -> str:
    if issue.get("state") == "closed":
        return "closed"
    names = {(lb.get("name") if isinstance(lb, dict) else None) for lb in issue.get("labels") or []}
    return next((x for x in cfg.progress_labels if x in names), "open")


def issue_view(issue: dict[str, Any], repo: str, cfg: ForgejoCfg, detail: bool = False) -> dict[str, Any]:
    body = str(issue.get("body") or "")
    assignees = [a.get("login") for a in issue.get("assignees") or [] if isinstance(a, dict) and a.get("login")]
    out: dict[str, Any] = {
        "repo": repo, "number": issue.get("number"), "title": str(issue.get("title") or ""), "state": issue.get("state"),
        "column": column_of(issue, cfg), "assignee": assignees[0] if assignees else None, "assignees": assignees,
        "labels": [{"name": lb.get("name"), "color": lb.get("color") or ""} for lb in issue.get("labels") or [] if isinstance(lb, dict) and lb.get("name")],
        "comments": int(issue.get("comments") or 0), "created_at": issue.get("created_at"), "updated_at": issue.get("updated_at"),
        "url": issue.get("html_url"), "author": (issue.get("user") or {}).get("login"),
        "snippet": " ".join(body.split())[:SNIPPET],
    }
    if detail:
        out["body"] = body
    return out


class ForgejoClient:
    def __init__(self, cfg: ForgejoCfg, http: httpx.AsyncClient):
        self.cfg, self.http = cfg, http

    def _headers(self) -> dict[str, str]:
        token = os.environ.get(self.cfg.token_env, "").strip()
        if not token:
            raise UpstreamError(503, f"Der Token ist nicht gesetzt: Umgebungsvariable {self.cfg.token_env} fehlt auf dem Server")
        return {"Authorization": f"token {token}", "Accept": "application/json"}

    async def _req(self, method: str, path: str, *, params: dict[str, Any] | None = None, json_body: Any = None) -> Any:
        try:
            r = await self.http.request(method, f"{self.cfg.base_url}/api/v1{path}", params=params, json=json_body, headers=self._headers(), follow_redirects=False, timeout=15.0)
        except httpx.HTTPError as e:
            raise UpstreamError(502, f"Forgejo nicht erreichbar ({type(e).__name__})") from e
        if r.status_code in (401, 403):
            raise UpstreamError(502, "Forgejo lehnt den Token ab (fehlt das Recht für Issues?)")
        if r.status_code == 404:
            raise UpstreamError(404, "Repo oder Issue bei Forgejo nicht gefunden")
        if r.status_code >= 400:
            msg = ""
            try:
                msg = str(r.json().get("message", ""))[:200]
            except Exception:
                pass
            raise UpstreamError(422 if r.status_code == 422 else 502, f"Forgejo meldet {r.status_code}" + (f": {msg}" if msg else ""))
        if r.status_code == 204 or not r.content:
            return None
        try:
            return r.json()
        except ValueError as e:
            raise UpstreamError(502, "Forgejo antwortet nicht mit JSON") from e

    @staticmethod
    def _rp(repo: str) -> str:
        owner, name = repo.split("/", 1)
        return f"/repos/{quote(owner, safe='')}/{quote(name, safe='')}"

    async def issues(self, repo: str, state: str = "all") -> tuple[list[dict[str, Any]], bool]:
        out: list[dict[str, Any]] = []
        for page in range(1, MAX_PAGES + 1):
            batch = await self._req("GET", f"{self._rp(repo)}/issues", params={"type": "issues", "state": state, "limit": PAGE, "page": page, "sort": "recentupdate"})
            if not isinstance(batch, list):
                raise UpstreamError(502, "Unerwartete Antwort von Forgejo")
            out += [issue_view(i, repo, self.cfg) for i in batch if isinstance(i, dict) and not i.get("pull_request")]
            if len(batch) < PAGE:
                return out, False
        return out, True

    async def issue(self, repo: str, number: int) -> dict[str, Any]:
        raw = await self._req("GET", f"{self._rp(repo)}/issues/{number}")
        if not isinstance(raw, dict) or raw.get("pull_request"):
            raise UpstreamError(404, "Repo oder Issue bei Forgejo nicht gefunden")
        comments = await self._req("GET", f"{self._rp(repo)}/issues/{number}/comments") or []
        view = issue_view(raw, repo, self.cfg, detail=True)
        view["comment_list"] = [{"id": c.get("id"), "author": (c.get("user") or {}).get("login"), "body": str(c.get("body") or ""), "created_at": c.get("created_at")}
                                for c in comments if isinstance(c, dict)]
        return view

    async def labels(self, repo: str) -> list[dict[str, str]]:
        raw = await self._req("GET", f"{self._rp(repo)}/labels", params={"limit": 100}) or []
        return [{"name": lb["name"], "color": lb.get("color") or ""} for lb in raw if isinstance(lb, dict) and lb.get("name")]

    async def create(self, repo: str, title: str, body: str, assignee: str | None, labels: list[str]) -> dict[str, Any]:
        payload: dict[str, Any] = {"title": title, "body": body}
        if assignee:
            payload["assignees"] = [assignee]
        if labels:
            payload["labels"] = labels
        raw = await self._req("POST", f"{self._rp(repo)}/issues", json_body=payload)
        return issue_view(raw, repo, self.cfg, detail=True)

    async def update(self, repo: str, number: int, *, title: str | None, body: str | None, assignee: str | None, column: str | None, labels: list[str] | None) -> dict[str, Any]:
        cur = await self.issue(repo, number)
        patch: dict[str, Any] = {}
        if title is not None:
            patch["title"] = title
        if body is not None:
            patch["body"] = body
        if assignee is not None:
            patch["assignees"] = [assignee] if assignee else []
        names = [lb["name"] for lb in cur["labels"]] if labels is None else list(labels)
        relabel = labels is not None
        if column is not None:
            if column not in self.cfg.columns:
                raise UpstreamError(422, "Unbekannte Spalte")
            names = [n for n in names if n not in self.cfg.progress_labels]
            if column in self.cfg.progress_labels:
                names.append(column)
            relabel = True
            patch["state"] = "closed" if column == "closed" else "open"
        if patch:
            await self._req("PATCH", f"{self._rp(repo)}/issues/{number}", json_body=patch)
        if relabel:
            await self._req("PUT", f"{self._rp(repo)}/issues/{number}/labels", json_body={"labels": names})
        return await self.issue(repo, number)

    async def comment(self, repo: str, number: int, body: str) -> None:
        await self._req("POST", f"{self._rp(repo)}/issues/{number}/comments", json_body={"body": body})
