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
  runStore.ts        Run-Zustand aller Unterhaltungen (läuft beim Seitenwechsel weiter); attention.ts leitet daraus Inbox, Cockpit und Zähler ab
  components/        Shell, Sidebar (nach Host gruppiert), Sigil, Icon; chat/: Rail, Session-Spalte, Verlauf, Dock, Inspector
  pages/             Cockpit, Inbox, Hosts, Agent/Chat, Profil bearbeiten, Darstellung
  bgfx.ts            Hintergrund-Shader (WebGL 1, gebündelt); components/BgFx.tsx hängt ihn hinter die Seiten
  tokens.css         Look A: alle Farben und Maße; styles/*.css nutzen nur diese Tokens
  styles/mobile.css  Handy (bis 800 px): Tab-Leiste unten (components/BottomNav.tsx), Touch-Ziele ab 44 px, kompakte Karten, Shader aus
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

### Cockpit und Inbox: woher die Zahlen kommen

Cockpit, Inbox, Seitenleiste und Tab-Titel lesen denselben Zustand (`runStore.ts`). Er enthält **die Runs, die diese WebUI selbst gestartet hat**:
Der Stream bleibt offen, auch wenn man zum Cockpit wechselt, und eine offene Freigabe oder Rückfrage erscheint sofort in der Inbox.
Runs aus CLI, Cron oder anderen Fenstern kennt die WebUI noch nicht, weil Hermes' API sie nicht als Liste anbietet; ein Neuladen der Seite beendet die Anzeige
(die Runs laufen in Hermes weiter). Was Hermes nicht bestätigt hat, steht nicht in der Oberfläche: Kosten, Kontext-Füllstand, TTFT, Auswertung je Profil.
Die Karten zeigen Zustand, Tätigkeit und den letzten Chat aus `/api/sessions`.

### Tool-Aufrufe: woher Argumente und Ausgabe kommen

Hermes' Ereignisstrom meldet einen Tool-Aufruf nur mit Name, Vorschau und Dauer (`tool.started`/`tool.completed`), **ohne Argumente und ohne Ausgabe**.
Beides steht erst im Verlauf der Session (`/api/sessions/{id}/messages`: `tool_calls` in der Assistenten-Nachricht, das Ergebnis als Nachricht mit Rolle `tool`).
Die WebUI lädt den Verlauf deshalb kurz nach jedem Tool und nach dem Ende des Runs nach und ergänzt die Karten (`history.ts`, `enrichTools`).
Alte Chats zeigen dieselben Karten, ebenso den Denkprozess (`reasoning`).

### Prüfen, ohne alles von Hand anzuklicken

Drei Schichten, jede fängt etwas anderes:

1. **Automatische Tests** (`pytest`, `npm test`, `tsc`, Build; laufen in der CI bei jedem Push). Der Hermes-Mock (`devtools/mock_hermes.py`) spricht
   die Formen, die Hermes 0.21.6 tatsächlich liefert, nicht erfundene.
2. **Diagnose-Ring** (Seite **System**, `GET …/diagnose`): liest je Agent Erreichbarkeit, Fähigkeiten, Modelle, Sessions und den Verlauf und meldet jede Abweichung
   von dem, was die WebUI erwartet (`ok`, `warn`, `fail`). Er läuft gegen die echten Agents, schreibt nichts und zeigt, wenn Hermes nach einem Update anders antwortet.
3. **Lauftest** (Knopf auf der Seite System, `POST …/diagnose/run`): ein kurzer echter Lauf je Agent (Start, Ereignisstrom, Abschluss, Antwort im Verlauf).
   Er legt eine Session an, die bestehen bleibt (Löschen ist in diesem Projekt bewusst nicht vorgesehen).

### Gedächtnis (`memory.json`)

Die Seite **Gedächtnis** liest, was ein Gedächtnis-Anbieter über die Agents weiß. Anbieter stehen in der Datei, auf die `HERMES_WEBUI_MEMORY_FILE` zeigt
(Vorlage `backend/memory.example.json`; Schlüssel nur per `api_key_env`). Jeder Anbieter meldet seine Fähigkeiten (`stats`, `items`, `search`, `graph`,
`entities`, `models`, `reflect`), und die Seite zeigt nur die Ansichten, die er kann. Hindsight ist der erste Typ (`app/memory.py`); ein weiterer Typ ist
eine Klasse mit denselben Methoden. Die Seite schreibt nichts. Die Antwortformen sind nach Hindsights OpenAPI normalisiert, noch nicht gegen die
laufende Instanz geprüft: **Verbindung prüfen** auf der Seite zeigt Abweichungen. `reflect` ruft beim Anbieter ein Sprachmodell auf, ist darum begrenzt und im Audit.

### Räume (Gruppenchats)

Hermes' Räume gibt es nur in der Desktop-App (Gateway-Schnittstelle `groups.*`), nicht in der HTTP-API. Die WebUI baut sie mit normalen Runs nach
(`app/rooms.py`): Jedes Mitglied hat eine eigene Session in seinem Agent (Titel „Gruppe: <Raum> · <Agent>“), das BFF führt das Gespräch.

- 2 bis 6 Mitglieder, Namen eindeutig (`@Name` muss genau eins treffen). Raumliste, Nachrichten und Session je Mitglied liegen in SQLite (`HERMES_WEBUI_ROOMS_DB`, auf Hikari `/data/rooms.db`).
- Ein Absenden löst höchstens 3 Runden und 10 Agent-Nachrichten aus. Erste Runde: die @-Erwähnten, ohne Erwähnung alle (`@all` ebenso). Danach antworten die, die jemand in der Runde davor erwähnt hat. `[PASS]` heißt: nichts beizutragen. Eine stille Runde beendet das Absenden.
- `@user` in einer Agent-Nachricht hält den Raum an und markiert ihn als „braucht dich“. Freigaben und Rückfragen der Mitglieder erscheinen im Raum und gehen über den Run des jeweiligen Mitglieds.
- Je Zug sieht ein Mitglied nur die Raumnachrichten seit seinem letzten Zug (seine Session kennt den Rest). Gelöscht wird nichts, ein Raum lässt sich nur archivieren.
- Abweichung von Hermes' Desktop: eine neue Nachricht während eines laufenden Zugs wird abgelehnt (Stopp oder abwarten), sie wird nicht eingereiht.

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

### Dashboard (SOUL und Profil-Einstellungen)

Die Agent-API kennt weder `SOUL.md` noch Profil-Einstellungen. Dafür gibt es `hermes dashboard`: ein eigener Prozess je Maschine, der alle Profile verwaltet
(`GET /api/profiles`, `GET|PUT /api/profiles/<name>/soul`, `PUT …/description`, `PUT …/model`). Das BFF ist sein einziger Client (`app/dashboard.py`); der Browser sieht
das Dashboard und seinen Token nie. Eingetragen wird es je Runtime in der `hosts.json`:

```json
{ "id": "hermes", "base_url": "http://127.0.0.1:9121", …,
  "dashboard": { "base_url": "http://127.0.0.1:9122", "token_env": "HERMES_DASHBOARD_TOKEN" } }
```

- **Token:** Das Dashboard verlangt für jede `/api/`-Route den Header `X-Hermes-Session-Token`. Ohne festen Wert würfelt es bei jedem Start einen neuen; darum startet `deploy/dashboard.sh` es mit `HERMES_DASHBOARD_SESSION_TOKEN` und legt denselben Wert als `HERMES_DASHBOARD_TOKEN` in `webui.env` ab.
- **Start auf Hikari:** `bash deploy/dashboard.sh`, danach `bash deploy/deploy.sh`. Das Skript startet das Dashboard im Container `hermes-agents` auf `127.0.0.1:9122` (9119 gehört dem Host-Dashboard), ergänzt den Eintrag in der `hosts.json` und gibt nie einen Wert aus. Das Dashboard endet mit dem Container, dann das Skript erneut starten.
- **Ohne Dashboard** zeigt die Seite „SOUL & Profil“ einen Hinweis mit dem Eintrag; alles andere in der WebUI läuft unverändert.
- **SOUL.md ändern** verlangt eine frische Anmeldung (Step-up, wie „immer erlauben“). Vor jedem Speichern legt das BFF den bisherigen Text unter `HERMES_WEBUI_SOUL_DIR` ab (je Agent ein Ordner, auf Hikari `/data/soul-history`), der Verlauf wird nie gekürzt. Das Speichern prüft den Fingerabdruck des geladenen Texts (409, falls sich die Datei inzwischen geändert hat), liest zur Kontrolle zurück und schreibt ins Audit-Log nur Längen, nie Text.
- Nicht geprüft gegen das echte Dashboard im Container (Hermes 0.21.6): die Formen folgen dem Quelltext von Hermes 0.19 und dem Mock (`backend/devtools/mock_dashboard.py`). Weicht die Antwort ab, meldet die Seite es als Fehler, ohne etwas zu verändern.

### hosts.json

```json
{ "hosts": [
  { "id": "hikari", "label": "Hikari", "kind": "local", "runtimes": [
    { "id": "hermes", "base_url": "http://127.0.0.1:9121", "api_key_env": "HERMES_KEY_HIKARI",
      "multiplex": true, "agents": ["benzai", "default", "…"] } ] },
  { "id": "laptop", "label": "Laptop", "kind": "remote", "address": "100.100.3.4", "runtimes": [ … ] }
] }
```

- **Hikari:** angebunden wird nur das Container-Gateway (`127.0.0.1:9121`, Profile unter `/p/<profil>/`). Das Host-Gateway auf `:8642` bedient keine Profile und bleibt außen vor. Basis-URL, Key-Variable und Profilliste stehen ausschließlich im Instanz-Eintrag der `hosts.json`; die Profilnamen im Beispiel sind nicht fest verdrahtet.
- `api_key_env` (oder `api_key`, nur Entwicklung) gilt für die Runtime; ein Agent darf einen eigenen Eintrag `{ "id": "inari", "api_key_env": "HERMES_KEY_INARI" }` haben, der Vorrang hat. Das Container-Gateway auf Hikari gibt jedem Profil außer `default` ein eigenes `API_SERVER_KEY`; `deploy/profile-keys.sh` trägt sie aus den Profilordnern in `webui.env` ein.
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
- `label` (1 bis 40 Zeichen) je Profil ist ein Anzeigename; ohne ihn gilt der Ordnername aus Hermes. Ein Eintrag darf auch nur ein `label` enthalten.

**Bearbeiten in der WebUI.** Die Profil-Seite (`/h/<host>/<runtime>/<agent>/profil`, Stift in der Session-Spalte und auf der Host-Seite) wählt Symbol, Initialen oder ein eigenes SVG, Farbton und Anzeigename mit Vorschau und schreibt das in die `ui.json`
(`PUT /bff/ui/profiles/<schlüssel>`; Schlüssel immer `host/runtime/agent`, ein allgemeiner Eintrag für den Profilnamen bleibt als Rückfall bestehen). Der Hintergrund-Shader hat auf `/settings` („Darstellung“) Regler für Stärke und Tempo,
die zuerst nur für das Gerät gelten (Browser-Speicher) und dort als Vorgabe für alle Geräte gespeichert werden können (`PUT /bff/ui/shader`).

- Geschrieben wird nur, wenn die WebUI die Datei ändern darf. Sonst zeigt `GET /bff/ui` `"writable": false` samt Grund, das Speichern ist abgeschaltet und die Profil-Seite zeigt den fertigen Eintrag zum Kopieren. Im Container also den Config-Ordner schreibbar einbinden, wenn die Seite speichern soll; ein einzelner Bind-Mount der Datei geht auch (dann wird ohne Austausch der Datei direkt geschrieben).
- Es ändert sich nur der Teil, den die Seite bearbeitet: unbekannte Schlüssel und andere Profile bleiben, der Stand davor liegt als `ui.json.bak` daneben, geschrieben wird atomar. Eine Datei, die kein gültiges JSON ist, wird nie überschrieben (409).
- Neue SVG-Dateien gehen als Text an das BFF, werden wie beim Laden bereinigt und landen als `sigils/<profil>-<kurzhash>.svg`; bei einem Fehler wird nichts geändert. Jede Änderung steht im Audit-Log (`ui.profile`, `ui.shader`), ohne Namen oder Inhalte.

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

## Betrieb auf Hikari

Ein Container mit `network_mode: host` (das Container-Gateway lauscht nur auf `127.0.0.1:9121`), BFF und Frontend in einem Image, davor Caddy.

```bash
git clone https://github.com/marct3797/Hermes-WebUI && cd Hermes-WebUI && git checkout <Branch>
bash deploy/deploy.sh          # legt ~/hermes-webui/{config,data,webui.env} an, startet den Container, wartet auf /healthz
```

- `deploy/deploy.sh` ist idempotent, löscht nichts und überschreibt keine vorhandene Config. Den Key des Container-Gateways liest es aus der Umgebung von `hermes-agents` in `webui.env` (`chmod 600`), ohne ihn auszugeben. Fehlen die Forgejo-Werte (`FORGEJO_OIDC_CLIENT_ID`, `FORGEJO_OIDC_CLIENT_SECRET`, `OIDC_ALLOWED_SUB`), nennt es die Namen und stoppt.
- Forgejo-OAuth-App: Redirect-URI `https://agents.thiel.digital/auth/callback`; `OIDC_ALLOWED_SUB` ist die numerische Forgejo-Benutzer-ID.
- Caddy: Block aus `deploy/Caddyfile.snippet` (SSE ohne Pufferung).
- Rauchtest durch das BFF ohne Login: ein Wegwerf-Container mit `HERMES_WEBUI_ENV=dev`, `AUTH_MODE=none` auf `127.0.0.1:8421`, dann `python backend/devtools/smoke_bff.py --agent inari`.
- Aktualisieren: Branch holen, `bash deploy/deploy.sh` erneut.

## Offene Prüfpunkte für Phase 1 (gegen die echte Instanz)

Das Eventformat und die Routen stammen aus der Quelltext-Lesung (Hermes 0.20.4), noch nicht aus einem Lauf mit Key.
Abweichungen zeigen sich als `unknown`-Events oder Probe-Fehler und werden im Hermes-Adapter behoben.

- Antwortet `/p/<profil>/…` am Container-Gateway wie erwartet? Passen Payloads und Events (ein Test-Run mit Key, Marc gibt frei)?
  Dafür gibt es `backend/devtools/probe_hermes.py`: schickt einen harmlosen Prompt und gibt nur die **Form** der Antworten aus (Texte als Länge, nie den Key).
- `POST /v1/runs` liefert **keine** `session_id` (sie steht in `GET /v1/runs/{id}`); `session_id` im Body setzt eine Session fort. Geklärt am 2026-10-23.
- `/v1/capabilities`: `features` mit Flags (`run_steer`, `run_approval_response`, `session_fork` …), `endpoints` mit den Routen. Eine Clarify-Route nennt Hermes dort nicht.
  Geklärt am 2026-10-23; offen bleibt nur, wie die Rückfrage-Karte antwortet, sobald es den ersten echten Fall gibt.
- Räume: ob echte Agents `@Name` und `[PASS]` so befolgen, wie der Prompt es verlangt (steht in `build_prompt`), zeigt erst ein Raum mit echten Profilen; der Mock antwortet immer gleich.
- Forgejo: OIDC-Discovery, `sub`-Kennung, ob `prompt=login` und `max_age=0` eine neue Anmeldung erzwingen (Step-up).
- Laptop (Phase 2): Hermes-API-Server dort läuft inzwischen auf `127.0.0.1:8642`; der Host-Dienst bringt den Transport.
