# Hermes-WebUI

Eigene WebUI für Agents: erst Hermes, später weitere Agent-Systeme (OpenCode, Claude Code, Antigravity)
auf mehreren Rechnern. Aufbau: React/Vite-Frontend (`frontend/`) und ein schlankes FastAPI-Backend
(`backend/`, „BFF“). Der Browser spricht nur mit dem BFF; Keys bleiben serverseitig.

Stand: **Phase 0 (Fundament)**. Entwurfsdokument: Architektur v3 im Projekt. Sicherheit: [SECURITY.md](SECURITY.md).

## Begriffe

| | Bedeutung | Beispiel |
| --- | --- | --- |
| **Host** | Rechner mit Name, Adresse und Status (online, schläft, nicht erreichbar) | `hikari` (lokal), `laptop` (entfernt) |
| **Runtime** | Agent-System auf einem Host, je ein Adapter im BFF | `hermes` |
| **Agent** | Profil (Hermes) oder Projektordner (Coding-Agents): die Einheit in URL und Auswahl | `raiden` |

URL-Schema im Browser: `/` (Cockpit), `/inbox`, `/hosts`, `/h/<host>/<runtime>/<agent>/chat/<sessionId>`.
Weitere Module hängen sich an denselben Präfix. API des BFF: `/bff/h/<host>/<runtime>/<agent>/…`.
Alte Links `/p/<profil>/…` leiten auf `hikari/hermes` um.

## Aufbau

```
backend/app/
  registry.py        Hosts, Runtimes, Agents aus hosts.json (Hot-Reload, Fehler melden statt abstürzen)
  hosts.py           Host-Status, Adapter je Host/Runtime, Platzhalter für Hosts ohne Verbindung
  adapters/
    __init__.py      Adapter-Schnittstelle (RuntimeAdapter), Fehler, Zustände
    hermes.py        Hermes-Adapter: der einzige Ort mit Hermes-Pfaden, Feldnamen und Eventnamen
  events.py          Gemeinsames Ereignisformat und Prüfung
  auth.py, oidc.py   Sitzungen, Forgejo-Login (PKCE), Step-up
  audit.py           Audit-Log (ohne Inhalte)
  security.py        CSP, CSRF, Limits
  routes/            auth, hosts (/bff/me, /bff/hosts), agents (/bff/h/…)
backend/devtools/    Hermes-Mock im echten Format
frontend/src/
  router.ts          URL-Schema ohne Router-Bibliothek
  hosts.tsx          Hosts/Agents samt Status (alle 30 s aufgefrischt)
  components/        Shell, Sidebar (nach Host gruppiert), Sigil, Icon; chat/: Rail, Session-Spalte, Verlauf, Dock, Inspector
  pages/             Cockpit, Inbox (Platzhalter), Hosts, Agent/Chat
  tokens.css         Look A: alle Farben und Maße; styles/*.css nutzen nur diese Tokens
```

### Ereignisformat

Alle Adapter liefern dasselbe: `run.started`, `message.delta`, `reasoning.delta`, `tool.started`,
`tool.completed`, `approval.requested` (mit erlaubten `choices`), `approval.responded`, `clarify.requested`,
`run.steered`, `subagent.started|completed`, `run.completed`, `run.failed`, `run.stopped`, `stream.error`.
Was eine Runtime nicht kann, meldet sie als Fähigkeit (`features` im Status); das UI blendet es aus.
Das BFF sendet unbenannte SSE-Frames, der Typ steckt im JSON (`backend/app/events.py`).

### Neue Runtime anbinden

Adapter von `RuntimeAdapter` ableiten, in `adapters/__init__.py:adapter_classes` eintragen, Runtime in
`hosts.json` nennen. Das Frontend bleibt unverändert.

## Entwicklung

```bash
# Backend
cd backend
python -m venv .venv && . .venv/bin/activate && pip install -e '.[dev]'
cp hosts.example.json hosts.json           # Hosts, Runtimes, Agents; Keys per api_key_env
uvicorn devtools.mock_hermes:app --port 8642 &   # Hermes-Mock (Key: dev-key), optional
uvicorn app.main:app_factory --factory --port 8000
pytest

# Frontend (Proxy /bff und /auth -> :8000)
cd frontend && npm install && npm run dev
npm test && npm run build
```

Für den Mock in `hosts.json`: `"base_url": "http://127.0.0.1:8642", "api_key": "dev-key"` und die Agents
`default`, `omoikane` (die der Mock kennt).

### hosts.json

```json
{ "hosts": [
  { "id": "hikari", "label": "Hikari", "kind": "local", "runtimes": [
    { "id": "hermes", "base_url": "http://127.0.0.1:9121", "api_key_env": "HERMES_KEY_HIKARI",
      "multiplex": true, "agents": ["benzai", "default", "…"] } ] },
  { "id": "laptop", "label": "Laptop", "kind": "remote", "address": "100.100.3.4", "runtimes": [ … ] }
] }
```

- `multiplex: true`: ein Gateway bedient mehrere Profile unter `/p/<profil>/…`. Ohne Multiplex ist genau ein Agent erlaubt (Hermes ignoriert dann das Präfix).
- Die Agent-Liste ist vorerst fest in der Datei (Anzeigename = Ordnername). Auto-Erkennung folgt, sobald ein lesbarer Weg zu den Profilordnern im Container steht.
- Remote-Hosts erscheinen in der Registry, sind aber bis Phase 2 (Host-Dienst) „nicht erreichbar“.
- Ungültige Datei: das BFF behält die letzte gültige Fassung und meldet den Fehler unter `/bff/hosts` (`config_error`).

### ui.json (Sigils, Symbol-Packs, Hintergrund-Shader)

Die Optik der Profile gehört zur WebUI-Config, nie zu Hermes. `HERMES_WEBUI_UI_FILE` zeigt auf eine `ui.json`
(Vorlage: `backend/ui.example.json`); fehlt sie, zeigt die WebUI Initialen mit einem Farbton aus dem Profilnamen.
Neben der Datei dürfen `sigils/<name>.svg` und `packs/<id>.json` liegen. Änderungen gelten ohne Neustart.

```json
{ "ui": { "backgroundShader": { "enabled": true, "strength": 1.6, "speed": 1.0 } },
  "packs": ["japan"],
  "profiles": {
    "raiden": { "sigil": { "type": "glyph", "glyph": "japan/raiden", "hue": 98 } },
    "hikari/hermes/default": { "sigil": { "type": "initials", "text": "DF", "hue": null } },
    "docs": { "sigil": { "type": "svg", "src": "sigils/docs.svg" } } } }
```

- Schlüssel: `agent` (gilt auf allen Hosts) oder `host/runtime/agent` (hat Vorrang).
- `type`: `glyph` (`neutral/<symbol>` aus den 24 Standard-Symbolen oder `<pack>/<name>`), `initials` (`text`, höchstens 3 Zeichen) oder `svg` (`src` = `sigils/<name>.svg`).
- `hue`: Zahl 0 bis 360, `"auto"` (aus dem Namen) oder `null` (neutral grau). Helligkeit und Sättigung sind fest, damit der Kontrast stimmt.
- Eigene SVGs und Pack-Symbole: einfarbig, höchstens 20 KB, nur Formen (`path`, `circle`, `rect` …). Das BFF bereinigt sie beim Laden, lehnt alles Aktive oder Externe ab und liefert sie aus dem Speicher mit eigener, strenger CSP aus; das Frontend rendert sie als Maske, nie als Inline-SVG.
- Im Standard steckt nichts Japanisches: `backend/examples/japan/` ist ein fertiger Beispielordner mit den neun Profil-Symbolen zum optionalen Einsatz.

## Betrieb (hinter Caddy)

Caddy terminiert TLS und leitet an den BFF (`127.0.0.1:8000`). Der BFF liefert das gebaute Frontend selbst aus
(`HERMES_WEBUI_STATIC_DIR=frontend/dist`). Auf Hikari muss der BFF das Container-Gateway auf `127.0.0.1:9121`
erreichen (Host-Netzwerk).

| Variable | Bedeutung |
| --- | --- |
| `HERMES_WEBUI_ENV` | `dev` (Standard) oder `prod` (HSTS, keine API-Doku, verlangt vollständigen Login) |
| `HERMES_WEBUI_AUTH_MODE` | `none` (nur dev) oder `oidc` |
| `HERMES_WEBUI_HOSTS_FILE` | Pfad zur `hosts.json`; wird bei Änderung ohne Neustart neu gelesen |
| `HERMES_WEBUI_STATIC_DIR` | gebautes Frontend |
| `HERMES_WEBUI_UI_FILE` | Pfad zur `ui.json` (Sigils, Packs, Shader), optional; wird bei Änderung neu gelesen |
| `HERMES_WEBUI_ALLOWED_HOSTS` | erlaubte Host-Header, kommagetrennt (prod: `agents.thiel.digital`) |
| `HERMES_WEBUI_PUBLIC_URL` | Öffentliche Adresse, Grundlage der Redirect-URI (`https://agents.thiel.digital`) |
| `HERMES_WEBUI_TRUSTED_PROXIES` | Adressen, deren `X-Forwarded-For` gilt (Standard: Loopback) |
| `HERMES_WEBUI_AUDIT_FILE` | Audit-Log (Standard `audit.log`, Modus 0600) |
| `FORGEJO_ISSUER` | z. B. `https://git.thiel.digital` |
| `FORGEJO_OIDC_CLIENT_ID`, `FORGEJO_OIDC_CLIENT_SECRET` | OAuth2-Anwendung in Forgejo (vertraulicher Client, Redirect `<PUBLIC_URL>/auth/callback`, Scopes `openid profile`) |
| `OIDC_ALLOWED_SUB` | Erlaubte Forgejo-Kennungen (`sub`), kommagetrennt |
| `HERMES_KEY_*` | API-Keys der Runtimes, Namen frei über `api_key_env` in der Config |

Secrets nie in Repo, Chat oder Frontend: Umgebung oder Datei mit Modus 0600.

## Offene Prüfpunkte für Phase 1 (gegen die echte Instanz)

Das Eventformat und die Routen stammen aus der Quelltext-Lesung (Hermes 0.20.4), noch nicht aus einem Lauf mit Key.
Abweichungen zeigen sich als `unknown`-Events oder Probe-Fehler und werden im Hermes-Adapter behoben.

- Antwortet `/p/<profil>/…` am Container-Gateway wie erwartet? Passen Payloads und Events (ein Test-Run mit Key, Marc gibt frei)?
  Dafür gibt es `backend/devtools/probe_hermes.py`: schickt einen harmlosen Prompt und gibt nur die **Form** der Antworten aus (Texte als Länge, nie den Key).
- Liefert `POST /v1/runs` eine `session_id`, und wie setzt der Client eine neue Session fort (`session_id` im Body oder vorher `POST /api/sessions`)?
- Form von `/v1/capabilities` (Flags für die Fähigkeiten) und Name/Route der Rückfrage (Clarify): im Quelltext nicht belegt.
- Forgejo: OIDC-Discovery, `sub`-Kennung, ob `prompt=login` und `max_age=0` eine neue Anmeldung erzwingen (Step-up).
- Laptop (Phase 2): Hermes-API-Server dort läuft inzwischen auf `127.0.0.1:8642`; der Host-Dienst bringt den Transport.
