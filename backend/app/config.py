from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import AliasChoices, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


def _env(*names: str) -> AliasChoices:
    return AliasChoices(*names)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="HERMES_WEBUI_", env_file=".env", extra="ignore", populate_by_name=True
    )

    # "dev" erlaubt Betrieb ohne Login (nur Loopback), "prod" erzwingt Login und HSTS.
    env: Literal["dev", "prod"] = "dev"
    auth_mode: Literal["none", "oidc"] = "none"

    # Hosts, Runtimes und Agents (siehe hosts.example.json). Wird bei Änderung ohne Neustart neu gelesen.
    hosts_file: Path = Path("hosts.json")
    # UI-Einstellungen (Sigils, Packs, Shader), siehe ui.example.json. Fehlt die Datei, gelten Standardwerte.
    ui_file: Path | None = None
    # Gedächtnis-Anbieter (Hindsight …), siehe memory.example.json. Fehlt die Datei, ist die Seite Gedächtnis leer.
    memory_file: Path | None = None
    # Host, auf den alte /p/<profil>-Links zeigen.
    legacy_host: str = "hikari"

    # Gebautes Frontend. Leer = BFF liefert nur die API (Vite-Dev-Server übernimmt das UI).
    static_dir: Path | None = None

    # Erlaubte Host-Header, kommagetrennt (z. B. "agents.thiel.digital").
    allowed_hosts: str = "localhost,127.0.0.1,testserver"
    # Nur von diesen Adressen werden X-Forwarded-For-Header beachtet (Marcs Caddy auf dem Host).
    trusted_proxies: str = "127.0.0.1,::1"
    # Öffentliche Adresse der WebUI, Grundlage der Redirect-URI (z. B. https://agents.thiel.digital).
    public_url: str = ""

    # Forgejo als OIDC-Anbieter. Die Namen ohne Präfix entsprechen der Architektur (Abschnitt Sicherheit).
    oidc_issuer: str = Field("", validation_alias=_env("FORGEJO_ISSUER", "HERMES_WEBUI_OIDC_ISSUER"))
    oidc_client_id: str = Field("", validation_alias=_env("FORGEJO_OIDC_CLIENT_ID", "HERMES_WEBUI_OIDC_CLIENT_ID"))
    oidc_client_secret: SecretStr = Field(
        SecretStr(""), validation_alias=_env("FORGEJO_OIDC_CLIENT_SECRET", "HERMES_WEBUI_OIDC_CLIENT_SECRET")
    )
    # Erlaubte Forgejo-Kennungen (`sub`), kommagetrennt. Nur diese Konten kommen hinein.
    oidc_allowed_sub: str = Field("", validation_alias=_env("OIDC_ALLOWED_SUB", "HERMES_WEBUI_OIDC_ALLOWED_SUB"))

    session_idle_s: int = 12 * 3600
    session_max_s: int = 7 * 24 * 3600
    # Riskante Aktionen verlangen eine Anmeldung, die höchstens so alt ist.
    step_up_s: int = 600

    audit_file: Path = Path("audit.log")

    max_body_bytes: int = 2 * 1024 * 1024  # Bild-Anhänge als Data-URL brauchen etwas Platz
    runs_per_minute: int = 20
    logins_per_minute: int = 10
    upstream_timeout_s: float = 15.0
    # Wie lange ein Host-Status wiederverwendet wird (Sekunden).
    health_ttl_s: float = 5.0
    health_timeout_s: float = 2.0

    def host_list(self) -> list[str]:
        return _split(self.allowed_hosts)

    def proxy_list(self) -> set[str]:
        return set(_split(self.trusted_proxies))

    def allowed_subs(self) -> set[str]:
        return set(_split(self.oidc_allowed_sub))


def _split(value: str) -> list[str]:
    return [v.strip() for v in value.split(",") if v.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
