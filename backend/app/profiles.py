"""Profil-Register: welche Hermes-Profile gibt es und wie erreicht man ihren API-Server.

Die Datei wird bei jeder Abfrage per mtime geprüft, so tauchen neue Profile ohne Neustart auf
und gelöschte verschwinden. Keys stehen entweder in der Datei oder in einer Umgebungsvariablen
(`api_key_env`); sie verlassen den BFF nie.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

PROFILE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


@dataclass(frozen=True)
class Profile:
    name: str
    base_url: str
    api_key: str = field(repr=False, default="")
    label: str = ""

    def public(self) -> dict:
        return {"name": self.name, "label": self.label or self.name}


class ProfileRegistry:
    def __init__(self, path: Path):
        self._path = path
        self._mtime: float | None = None
        self._profiles: dict[str, Profile] = {}

    def _load(self) -> None:
        try:
            mtime = self._path.stat().st_mtime
        except FileNotFoundError:
            self._mtime, self._profiles = None, {}
            return
        if mtime == self._mtime:
            return
        raw = json.loads(self._path.read_text(encoding="utf-8"))
        profiles: dict[str, Profile] = {}
        for entry in raw.get("profiles", []):
            name = entry.get("name", "")
            if not PROFILE_NAME_RE.match(name):
                continue  # ungültige Namen nie in Upstream-URLs übernehmen
            key = entry.get("api_key") or os.environ.get(entry.get("api_key_env", ""), "")
            profiles[name] = Profile(
                name=name,
                base_url=entry["base_url"].rstrip("/"),
                api_key=key,
                label=entry.get("label", ""),
            )
        self._profiles, self._mtime = profiles, mtime

    def all(self) -> list[Profile]:
        self._load()
        return list(self._profiles.values())

    def get(self, name: str) -> Profile | None:
        self._load()
        return self._profiles.get(name)
