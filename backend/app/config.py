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
    # Stand des Codes (Git-Kurz-Hash), vom Image gesetzt. Die Seitenleiste zeigt ihn: so sieht man nach einem Deploy, was wirklich läuft.
    build: str = ""
    # Gedächtnis-Anbieter (Hindsight …), siehe memory.example.json. Fehlt die Datei, ist die Seite Gedächtnis leer.
    memory_file: Path | None = None
    # Wissens-Anbieter (selbst gehostetes RAG), siehe knowledge.example.json. Fehlt die Datei, ist die Seite Wissen aus der Seitenleiste ausgeblendet.
    knowledge_file: Path | None = None
    # So lange gilt die Quellen- und Dokumentübersicht (ein Scan der Chroma-Datenbank), bevor sie neu gelesen wird.
    knowledge_cache_s: int = 300
    # Gruppenchats (Räume): SQLite-Datei mit Raumliste, Nachrichten und der Session je Mitglied.
    rooms_db: Path = Path("rooms.db")
    # Verlauf der SOUL.md-Änderungen (ein Ordner je Agent). Wird nie gekürzt.
    soul_dir: Path = Path("soul-history")
    # Gebautes Frontend. Leer = BFF liefert nur die API (Vite-Dev-Server übernimmt das UI).
    static_dir: Path | None = None

    # Erlaubte Host-Header, kommagetrennt (z. B. "webui.example.com").
    allowed_hosts: str = "localhost,127.0.0.1,testserver"
    # Nur von diesen Adressen werden X-Forwarded-For-Header beachtet (der Reverse-Proxy vor der WebUI).
    trusted_proxies: str = "127.0.0.1,::1"
    # Öffentliche Adresse der WebUI, Grundlage der Redirect-URI (z. B. https://webui.example.com).
    public_url: str = ""

    # Beliebiger OIDC-Anbieter (Authorization Code + PKCE; getestet mit Forgejo). Die FORGEJO_*-Namen gelten weiter als Alias.
    oidc_issuer: str = Field("", validation_alias=_env("FORGEJO_ISSUER", "HERMES_WEBUI_OIDC_ISSUER"))
    oidc_client_id: str = Field("", validation_alias=_env("FORGEJO_OIDC_CLIENT_ID", "HERMES_WEBUI_OIDC_CLIENT_ID"))
    oidc_client_secret: SecretStr = Field(
        SecretStr(""), validation_alias=_env("FORGEJO_OIDC_CLIENT_SECRET", "HERMES_WEBUI_OIDC_CLIENT_SECRET")
    )
    # Erlaubte Kennungen (`sub` des ID-Tokens), kommagetrennt. Nur diese Konten kommen hinein.
    oidc_allowed_sub: str = Field("", validation_alias=_env("OIDC_ALLOWED_SUB", "HERMES_WEBUI_OIDC_ALLOWED_SUB"))

    session_idle_s: int = 12 * 3600
    session_max_s: int = 7 * 24 * 3600
    # Riskante Aktionen verlangen eine Anmeldung, die höchstens so alt ist. `HERMES_WEBUI_STEP_UP=off` schaltet das ab
    # (sinnvoll, wenn die WebUI nur in einem privaten Netz erreichbar ist und die Anmeldung selbst genügt).
    step_up: bool = True
    step_up_s: int = 600

    audit_file: Path = Path("audit.log")

    max_body_bytes: int = 2 * 1024 * 1024  # Bild-Anhänge als Data-URL brauchen etwas Platz
    runs_per_minute: int = 20
    logins_per_minute: int = 10
    upstream_timeout_s: float = 15.0
    # Wie lange ein Host-Status wiederverwendet wird (Sekunden).
    health_ttl_s: float = 5.0
    health_timeout_s: float = 2.0
    # Verbindungspool zu den Runtimes: so lange bleibt eine ungenutzte Verbindung offen (httpx-Standard: 5 s, zu kurz für Polling im Minutentakt).
    upstream_keepalive_s: float = 60.0
    # Cache der Dashboard-Brücke (Sekunden). Bei einem Fehler gilt der alte Stand bis dash_stale_max_s als Notlösung.
    dash_models_ttl_s: float = 300.0
    dash_state_ttl_s: float = 20.0
    dash_stale_max_s: float = 600.0
    # Diagnose: Cache und Zeitlimit der Prüfung "Modelle und Anbieter".
    diag_models_ttl_s: float = 60.0
    diag_models_timeout_s: float = 8.0

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
