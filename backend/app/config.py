from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="HERMES_WEBUI_", env_file=".env", extra="ignore")

    # "dev" erlaubt Betrieb ohne Login (nur Loopback), "prod" erzwingt Auth und HSTS.
    env: Literal["dev", "prod"] = "dev"
    auth_mode: Literal["none", "oidc"] = "none"

    # Datei mit den Hermes-Profilen (Name, Basis-URL, Key). Wird bei Änderung neu gelesen,
    # damit Profile ohne Neustart hinzukommen oder wegfallen.
    profiles_file: Path = Path("profiles.json")

    # Gebautes Frontend. Leer = BFF liefert nur die API (Vite-Dev-Server übernimmt das UI).
    static_dir: Path | None = None

    # Erlaubte Host-Header, kommagetrennt (z. B. "hermes.example.lan").
    allowed_hosts: str = "localhost,127.0.0.1,testserver"

    max_body_bytes: int = 2 * 1024 * 1024  # Bild-Anhänge als Data-URL brauchen etwas Platz
    runs_per_minute: int = 20
    upstream_timeout_s: float = 15.0

    def host_list(self) -> list[str]:
        return [h.strip() for h in self.allowed_hosts.split(",") if h.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
