# Hermes-WebUI

Eigene WebUI für den Hermes Agent. Aufbau: React/Vite-Frontend (`frontend/`) und ein schlankes
FastAPI-Backend (`backend/`, „BFF“), das die Hermes-API-Server der Profile bündelt. Der Browser
spricht nur mit dem BFF; API-Keys bleiben serverseitig.

Stand: **Chat-Seite** (Streaming, Tool-Karten, Approval, Rückfragen, Bildanhang, Sessions-Liste,
Profilwechsel). Die weiteren Module folgen einzeln.

## Entwicklung

```bash
# Backend
cd backend
python -m venv .venv && . .venv/bin/activate && pip install -e '.[dev]'
cp profiles.example.json profiles.json          # Profile + Keys (api_key_env = Name der Env-Variable)
uvicorn devtools.mock_hermes:app --port 8642 &  # Hermes-Mock (Key: dev-key), optional
uvicorn app.main:app_factory --factory --port 8000
pytest

# Frontend (Proxy /bff -> :8000)
cd frontend && npm install && npm run dev
npm test && npm run build
```

Für den Mock in `profiles.json`: `"base_url": "http://127.0.0.1:8642", "api_key": "dev-key"`.

## Betrieb (hinter Caddy)

Caddy terminiert TLS und leitet an den BFF (`127.0.0.1:8000`) weiter. Der BFF liefert das gebaute
Frontend selbst aus (`HERMES_WEBUI_STATIC_DIR=frontend/dist`).

| Variable | Bedeutung |
| --- | --- |
| `HERMES_WEBUI_ENV` | `dev` (Standard) oder `prod` (HSTS, kein `/bff/docs`, verlangt Login-Modus) |
| `HERMES_WEBUI_AUTH_MODE` | `none` (nur dev) oder `oidc` (Forgejo, noch nicht implementiert) |
| `HERMES_WEBUI_PROFILES_FILE` | Pfad zur Profil-Datei; wird bei Änderung ohne Neustart neu gelesen |
| `HERMES_WEBUI_STATIC_DIR` | gebautes Frontend |
| `HERMES_WEBUI_ALLOWED_HOSTS` | erlaubte Host-Header, kommagetrennt |

## Sicherheit (Stand Chat-Seite)

CSP ohne `unsafe-inline`/`unsafe-eval`, `frame-ancestors 'none'`, `nosniff`, `no-store` auf
`/bff/*`, Host-Allowlist, Origin- und `X-Requested-With`-Prüfung bei schreibenden Aufrufen,
Body-Limit, Rate-Limit für Runs, strikte ID-Validierung vor Upstream-Pfaden, Keys nie in Antworten.
Offen: Forgejo-Login (siehe `backend/app/auth.py`).

## Annahmen über Hermes

Pfade und Event-Namen stammen aus der Doku-Zusammenfassung, nicht aus einem laufenden Hermes.
Alles Hermes-spezifische steht in `backend/app/hermes.py`; erst gegen eine echte Instanz testen.
