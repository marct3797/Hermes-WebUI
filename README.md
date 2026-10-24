# Hermes-WebUI

Eigene WebUI für Agents: erst Hermes, später weitere Agent-Systeme (OpenCode, Claude Code, Antigravity)
auf mehreren Rechnern. Aufbau: React/Vite-Frontend (`frontend/`) und ein schlankes FastAPI-Backend
(`backend/`, „BFF“). Der Browser spricht nur mit dem BFF; Keys bleiben serverseitig.

Konfiguration ausschließlich über `hosts.json`, `memory.json`, `ui.json` und Umgebungsvariablen: keine Hostnamen, Profile oder Adressen im Code. Sicherheit: [SECURITY.md](SECURITY.md).

## Begriffe

| | Bedeutung | Beispiel |
| --- | --- | --- |
| **Host** | Rechner mit Name, Adresse und Status (online, schläft, nicht erreichbar) | `server` (lokal), `laptop` (entfernt) |
| **Runtime** | Agent-System auf einem Host, je ein Adapter im BFF | `hermes` |
| **Agent** | Profil (Hermes) oder Projektordner (Coding-Agents): die Einheit in URL und Auswahl | `gamma` |

URL-Schema im Browser: `/` (Cockpit), `/inbox`, `/hosts`, `/h/<host>/<runtime>/<agent>/chat/<sessionId>`.
Weitere Module hängen sich an denselben Präfix. API des BFF: `/bff/h/<host>/<runtime>/<agent>/…`.

## Aufbau

```
backend/app/
  registry.py        Hosts, Runtimes, Agents aus hosts.json (Hot-Reload, Fehler melden statt abstürzen)
  hosts.py           Host-Status, Adapter je Host/Runtime, Platzhalter für Hosts ohne Verbindung
  adapters/
    __init__.py      Adapter-Schnittstelle (RuntimeAdapter), Fehler, Zustände
    hermes.py        Hermes-Adapter: der einzige Ort mit Hermes-Pfaden, Feldnamen und Eventnamen
  events.py          Gemeinsames Ereignisformat und Prüfung
  auth.py, oidc.py   Sitzungen, OIDC-Login (PKCE), Step-up
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

### Wissen (`knowledge.json`)

Die Seite **Wissen** (`/knowledge`) zeigt und pflegt ein selbst gehostetes RAG-System: Statistik, Suche mit Quellenfilter und Links ins Repo, Quellen- und
Dokumentübersicht, Text einspeisen, einzelne Dokumente löschen. Anbieter stehen in der Datei, auf die `HERMES_WEBUI_KNOWLEDGE_FILE` zeigt (Vorlage
`backend/knowledge.example.json`). Fehlt die Datei, ist der Eintrag in der Seitenleiste ausgeblendet; `/knowledge` zeigt dann eine Anleitung.

- Typ `hermes-rag` (`app/knowledge.py`): `base_url` (Statistik, Suche, Einspeisen, Löschen), optional `chroma_url` (die Chroma-Datenbank dahinter, liefert Quellen, Dokumente und Chunk-Texte; **geschrieben wird nur beim Ersetzen eines Dokuments** und dann genau: alte Chunks löschen per Chroma-ID; ohne sie bleibt die Suche mit freiem Quellenfeld), `collection` (sonst die aus `/api/v1/stats`) und `link_template` mit
  `{repo}`, `{commit}`, `{path}` (jedes Teilstück wird URL-kodiert; fehlt ein Wert, gibt es keinen Link). URLs: nur http/https, keine Zugangsdaten darin.
- Die Quellenübersicht scannt die Chroma-Metadaten seitenweise (1000 je Anfrage, Abbruch bei 50 000 Chunks mit Hinweis) und merkt sich das Ergebnis
  `HERMES_WEBUI_KNOWLEDGE_CACHE_S` Sekunden (Standard 300); Einspeisen und Löschen verwerfen es.
- Schreiben (Einspeisen, Löschen) verlangt eine frische Anmeldung und steht im Audit (`knowledge.ingest`, `knowledge.delete`, ohne Textinhalt). Gelöscht wird
  nur über die `sync_id`. Ein Sync kann das Dokument wieder hinzufügen, sobald sich die Datei im Repository ändert.
  Duplikatprüfungen und Schreibsperren gelten für einen BFF-Prozess. Ohne `chroma_url` ist keine Duplikatprüfung möglich; bei einem abgeschnittenen Scan wird das Einspeisen abgelehnt.
  Der Adapter unterstützt die hier dokumentierte Hermes-RAG-API und Chroma v1, nicht beliebige RAG-Produkte. Der Zugriff zum Dienst muss im privaten Netz abgesichert sein; der Adapter sendet derzeit keine Anbieter-Zugangsdaten.

- Dokument-Detail (`GET /bff/knowledge/{id}/documents/{sync_id}`): Metadaten, Volltext und Chunks (höchstens 500 Chunks). Der Volltext entsteht aus den Chunks in Speicherreihenfolge; die Überlappung wird am Text erkannt und nur einmal gezeigt (bei periodischem Text kann das ungenau sein). Bearbeiten (`PUT` auf dieselbe Route, Audit `knowledge.update` ohne Text) speist die neue Fassung unter derselben `sync_id` ein und entfernt erst danach die alten Chunks nach Chroma-ID; schlägt das Einspeisen fehl, bleibt das Alte. Schlägt nur das Entfernen fehl, ist das Dokument vorübergehend doppelt (die Meldung sagt es). Das ist nicht atomar über beide Dienste und braucht `chroma_url` mit Schreibzugriff auf Chroma v1 (`POST /collections/{id}/delete`). Einspeisen und Ersetzen nehmen bis 1 MiB Text.

### Zeitpläne und Logs (Dashboard)

- `routes/cron.py`: `/bff/h/{host}/_cron/{profile}/schedules[/{id}[/runs|pause|resume|trigger]]`, `/targets`, `/blueprints`, `/skill-names` und `/bff/h/{host}/_logs`. Alles läuft über das Dashboard des Hosts (`/api/cron/*`, `/api/logs`). Schreiben verlangt eine frische Anmeldung und steht im Audit (`cron.create|update|pause|resume|trigger|delete`, nur Job-ID und Profil). Neue Zeitpläne und Vorlagen entstehen immer pausiert. Skript-Jobs (`script`/`no_agent`) sind System-Jobs: Ändern, Ausführen und Löschen nur mit `confirm_system`.
- Logs: Dateien `agent`, `errors`, `gateway`, `gui`, `desktop`; höchstens 500 Zeilen je Anfrage (Grenze des Dashboards) und 256 KiB; Zeilen mit Geheimnismustern und URL-Zugangsteile werden serverseitig geschwärzt (`redacted: true`).

### Devtools

`backend/devtools/` enthält Ersatzdienste für Tests und lokale Entwicklung: `mock_hermes.py`, `mock_dashboard.py`, `mock_hindsight.py` und `mock_rag.py`
(Wissensdienst samt Chroma-v1-Teil in der Form der echten, bereinigten Antworten unter `backend/tests/fixtures/real/`; Start: `uvicorn devtools.mock_rag:app --port 8000`).

### Räume (Gruppenchats)

Hermes' Räume gibt es nur in der Desktop-App (Gateway-Schnittstelle `groups.*`), nicht in der HTTP-API. Die WebUI baut sie mit normalen Runs nach
(`app/rooms.py`): Jedes Mitglied hat eine eigene Session in seinem Agent (Titel „Gruppe: <Raum> · <Agent>“), das BFF führt das Gespräch.

- 2 bis 6 Mitglieder, Namen eindeutig (`@Name` muss genau eins treffen). Raumliste, Nachrichten und Session je Mitglied liegen in SQLite (`HERMES_WEBUI_ROOMS_DB`, im Container `/data/rooms.db`).
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
`default`, `beta` (die der Mock kennt).

### Dashboard (SOUL und Profil-Einstellungen)

Die Agent-API kennt weder `SOUL.md` noch Profil-Einstellungen. Dafür gibt es `hermes dashboard`: ein eigener Prozess je Maschine, der alle Profile verwaltet
(`GET /api/profiles`, `GET|PUT /api/profiles/<name>/soul`, `PUT …/description`, `PUT …/model`). Das BFF ist sein einziger Client (`app/dashboard.py`); der Browser sieht
das Dashboard und seinen Token nie. Eingetragen wird es je Runtime in der `hosts.json`:

```json
{ "id": "hermes", "base_url": "http://127.0.0.1:9121", …,
  "dashboard": { "base_url": "http://127.0.0.1:9122", "token_env": "HERMES_DASHBOARD_TOKEN" } }
```

- **Token:** Das Dashboard verlangt für jede `/api/`-Route den Header `X-Hermes-Session-Token`. Ohne festen Wert würfelt es bei jedem Start einen neuen; darum startet `deploy/dashboard.sh` es mit `HERMES_DASHBOARD_SESSION_TOKEN` und legt denselben Wert als `HERMES_DASHBOARD_TOKEN` in `webui.env` ab.
- **Start im Docker-Betrieb:** `HERMES_CONTAINER` (Name des Hermes-Containers) in `webui.env` setzen, dann `bash deploy/dashboard.sh` und `bash deploy/deploy.sh`. Das Skript startet das Dashboard im Container auf `127.0.0.1:9122` (9119 gehört dem Host-Dashboard), ergänzt den Eintrag in der `hosts.json` und gibt nie einen Wert aus. Das Dashboard endet mit dem Container, dann das Skript erneut starten.
- **Lesende Ersatzquelle für Host-Daten:** Kanban, Logs, MCP, Plugins, Skills und die Inhaltssuche liest der Host-Dienst aus dem Dateisystem. Läuft Hermes im Container oder ist der Host-Dienst veraltet, sieht er die Profile nicht. Dann liest das BFF dieselben Daten über das Dashboard (`app/dashboard_ops.py`): nur lesend, Texte und Logs geschwärzt, bei MCP nie Env, Argumente oder URLs, je Spalte höchstens 50 Kanban-Aufgaben. Die Oberfläche nennt die Quelle. Schreibende Aktionen (Plugins aktivieren, installieren) bleiben beim Host-Dienst.
- **Step-up abschalten:** Standardmäßig verlangen Terminal, SOUL, Schlüssel und andere riskante Aktionen eine Anmeldung, die höchstens 10 Minuten alt ist. `HERMES_WEBUI_STEP_UP=off` schaltet das ab; dann zählt nur die normale Anmeldung (nur für Installationen, die ausschließlich in einem privaten Netz erreichbar sind; sonst an lassen). Die Seite **System** zeigt, ob der Anbieter die Frische der Anmeldung belegen kann (siehe SECURITY.md).
- **Ohne Dashboard** zeigt die Seite „SOUL & Profil“ einen Hinweis mit dem Eintrag; alles andere in der WebUI läuft unverändert.
- **SOUL.md ändern** verlangt eine frische Anmeldung (Step-up, wie „immer erlauben“). Vor jedem Speichern legt das BFF den bisherigen Text unter `HERMES_WEBUI_SOUL_DIR` ab (je Agent ein Ordner, im Container `/data/soul-history`), der Verlauf wird nie gekürzt. Das Speichern prüft den Fingerabdruck des geladenen Texts (409, falls sich die Datei inzwischen geändert hat), liest zur Kontrolle zurück und schreibt ins Audit-Log nur Längen, nie Text.
- **Anbieter (Hauptseite `/providers`)**: Je Host mit einer Hermes-Runtime eine Tabelle Profil × Anbieter/Modell × Zugang. `GET /bff/h/<host>/<runtime>/_provider-matrix` fragt je Profil das Dashboard der Maschine (`/api/profiles`, `/api/env`, `/api/providers/oauth`). Die Zugänge, die auf dem Host selbst laufen, stehen in `app/providers.py` (`ACCOUNTS`: OpenAI Codex per Gerätecode, Claude per Anthropic-Seite und Code oder Key, OpenCode Go per Key); weitere sind ein Eintrag dort. Ein Klick auf Anbieter/Modell öffnet die Auswahl (Liste aus `/api/model/options`, gespeichert über `PUT /api/profiles/<profil>/model`), ein Klick auf einen Zugang die Anmeldung. Die Anmeldung läuft im Dashboard (`/api/providers/oauth/<anbieter>/start`, `poll`, `submit`): die WebUI zeigt Code oder Link und fragt nach; sie verlangt Step-up und schreibt nur Anbieter und Profil ins Audit-Log. Fehlt das Dashboard oder ist es nicht erreichbar, bleiben die Profile aus der Config sichtbar und der Grund steht daneben. Die Coding-CLIs (`codex`, `claude`, `opencode`, `antigravity`) laufen über den Host-Dienst `hostd` (siehe `hostd/README.md`); ohne ihn zeigt die Seite „Host-Dienst nicht eingerichtet“.
- **Keys & Nutzung** (`/h/<host>/<runtime>/<agent>/providers`): Aus `/api/env`, `/api/providers/oauth` und `/api/analytics/models` baut `app/providers.py` je Profil eine Übersicht (eingerichtet per Key oder Anmeldung, Sessions, Tokens und Kosten der letzten 7/30/90 Tage). Nicht eingerichtete Anbieter sind eingeklappt und lassen sich per Knopf hinzufügen. Keys gehen nur Browser → BFF → Dashboard, werden vorher beim Anbieter geprüft (`/api/providers/validate`), verlangen Step-up und stehen weder in Antworten noch im Audit-Log (nur der Variablenname). Schreiben ist auf Variablen beschränkt, die das Dashboard einem Anbieter zuordnet. Fehlermeldungen wiederholen die abgelehnte Eingabe nie. Entfernen von Keys gibt es nicht. Restkontingente der Konten liefert das Dashboard-Plugin `ai-usage-tracker` (fehlt es, zeigt die Seite den Grund statt erfundener Zahlen). Die Coding-CLIs stehen auf der Hauptseite als eigener Abschnitt mit ihrem Anmeldestatus (`/bff/h/<host>/_cli-auth`).

### hosts.json

Zwei Vorlagen: `deploy/hosts.example.json` (Standard bei einer frischen Installation: ein Rechner, ein Agent `default`, Hermes-API auf `127.0.0.1:8642`, Key in `HERMES_KEY_LOCAL`) und `deploy/hosts.multiplex.example.json` (ein Gateway mit mehreren Profilen, eigener Key je Profil, Dashboard). Die Vorlage wird nie überschrieben, wenn `config/hosts.json` schon existiert.

```json
{ "hosts": [
  { "id": "server", "label": "Server", "kind": "local", "runtimes": [
    { "id": "hermes", "base_url": "http://127.0.0.1:9121", "api_key_env": "HERMES_KEY_SERVER",
      "multiplex": true, "agents": ["zeta", "default", "…"] } ] },
  { "id": "laptop", "label": "Laptop", "kind": "remote", "address": "100.64.3.4", "runtimes": [ … ] }
] }
```

- **Server:** angebunden wird nur das Container-Gateway (`127.0.0.1:9121`, Profile unter `/p/<profil>/`). Das Host-Gateway auf `:8642` bedient keine Profile und bleibt außen vor. Basis-URL, Key-Variable und Profilliste stehen ausschließlich im Instanz-Eintrag der `hosts.json`; die Profilnamen im Beispiel sind nicht fest verdrahtet.
- `api_key_env` (oder `api_key`, nur Entwicklung) gilt für die Runtime; ein Agent darf einen eigenen Eintrag `{ "id": "delta", "api_key_env": "HERMES_KEY_DELTA" }` haben, der Vorrang hat. Das Container-Gateway auf Server gibt jedem Profil außer `default` ein eigenes `API_SERVER_KEY`; `deploy/profile-keys.sh` trägt sie aus den Profilordnern in `webui.env` ein.
- `multiplex: true`: ein Gateway bedient mehrere Profile unter `/p/<profil>/…`. Ohne Multiplex ist genau ein Agent erlaubt (Hermes ignoriert dann das Präfix).
- Die Agent-Liste ist vorerst fest in der Datei (Anzeigename = Ordnername). Auto-Erkennung folgt, sobald ein lesbarer Weg zu den Profilordnern im Container steht.
- **Weiterer Host (Laptop, zweiter Server):** ein Eintrag mit `kind: "remote"` und der Tailnet-Adresse, sonst wie Server; es gibt keinen Sonderweg, Hermes dort antwortet über denselben Adapter. `deploy/add-host.sh <kennung> "<Name>" <adresse> [--dashboard-port N]` ergänzt den Eintrag in `~/hermes-webui/config/hosts.json` (nie überschreibend, mit Sicherung), fragt den Key still ab, legt ihn als `HERMES_KEY_<KENNUNG>` in `webui.env` und prüft die Verbindung. Danach `bash deploy/deploy.sh`.
- **Auf dem Host selbst** muss Hermes' API-Server auf der Tailnet-Adresse lauschen: `API_SERVER_ENABLED=true`, `API_SERVER_HOST=<Tailnet-IP>`, `API_SERVER_KEY=<mindestens 16 Zeichen>`, dann das Gateway neu starten. Ohne gültigen Key (fehlt, Platzhalter oder unter 16 Zeichen) startet der API-Server gar nicht und es gibt keinen Listener; `curl` meldet dann `000`. Das prüft man dort mit `ss -ltnp | grep 8642`. Die WebUI nennt bei einem Ausfall Adresse und Grund (keine Verbindung, Zeitüberschreitung, Key abgelehnt).
- Ungültige Datei: das BFF behält die letzte gültige Fassung und meldet den Fehler unter `/bff/hosts` (`config_error`).

### ui.json (Sigils, Symbol-Packs, Hintergrund-Shader)

Die Optik der Profile gehört zur WebUI-Config, nie zu Hermes. `HERMES_WEBUI_UI_FILE` zeigt auf eine `ui.json`
(Vorlage: `backend/ui.example.json`); fehlt sie, zeigt die WebUI Initialen mit einem Farbton aus dem Profilnamen.
Neben der Datei dürfen `sigils/<name>.svg` und `packs/<id>.json` liegen. Änderungen gelten ohne Neustart.

```json
{ "ui": { "backgroundShader": { "enabled": true, "strength": 1.6, "speed": 1.0 } },
  "packs": ["japan"],
  "profiles": {
    "gamma": { "sigil": { "type": "glyph", "glyph": "japan/gamma", "hue": 98 } },
    "server/hermes/default": { "sigil": { "type": "initials", "text": "DF", "hue": null } },
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

### Persönliche Einstellungen

`/settings` enthält Chat-Verhalten (Enter-Senden, am Verlaufende bleiben, Freigaben bestätigen), kompakte Listen, 12-/24-Stunden-Zeit und reduzierte Bewegung. Denkaufwand und Standard-Arbeitsordner werden je konfiguriertem Host gewählt. Diese Vorgaben liegen nur im Browser (`hermes.preferences`), nicht in der Server- oder Agent-Konfiguration. Die bestehende Aufwandwahl je Agent bleibt vorrangig; die Arbeitsordnerauswahl nutzt nur vom Host-Dienst freigegebene Ordner.

Desktop-Hinweis und Ton bei wartenden Freigaben sind getrennte Opt-ins. Erst der Klick in den Einstellungen fragt nach der Browser-Erlaubnis. Die Meldungen gelten nur für von dieser geöffneten WebUI erkannte Freigaben (inklusive Räume), nicht für unsichtbare CLI-Läufe. Der Testton zeigt Browser-Sperren; nach einem Neuladen kann vor dem ersten Klick noch kein Ton laufen. Eine Bestätigung auszuschalten ersetzt nie eine Freigabe oder die serverseitigen Sicherheitsprüfungen.

**Anbieter ausblenden:** Standardmäßig zeigt die WebUI alle Anbieter, die das Dashboard meldet. Wer bestimmte Produkte nicht sehen will, trägt ihre Kennungen in `HERMES_WEBUI_HIDDEN_PROVIDERS` ein (kommagetrennt, z. B. `nous,opencode-zen`). Der Filter gilt für Anbieterübersicht, Modellauswahl und Kontingente; Zugangsdaten werden weder gelöscht noch umgeschrieben.

## Betrieb (hinter einem Reverse-Proxy)

Der Reverse-Proxy (Caddy, nginx, Traefik …) terminiert TLS und leitet an den BFF (`127.0.0.1:8000`). Der BFF liefert das gebaute Frontend selbst aus
(`HERMES_WEBUI_STATIC_DIR=frontend/dist`). Läuft Hermes in einem Container, der nur auf `127.0.0.1` lauscht, muss der BFF mit Host-Netzwerk laufen (so setzt es `deploy/docker-compose.yml`).

| Variable | Bedeutung |
| --- | --- |
| `HERMES_WEBUI_ENV` | `dev` (Standard) oder `prod` (HSTS, keine API-Doku, verlangt vollständigen Login) |
| `HERMES_WEBUI_AUTH_MODE` | `none` (nur dev) oder `oidc` |
| `HERMES_WEBUI_HOSTS_FILE` | Pfad zur `hosts.json`; wird bei Änderung ohne Neustart neu gelesen |
| `HERMES_WEBUI_STATIC_DIR` | gebautes Frontend |
| `HERMES_WEBUI_UI_FILE` | Pfad zur `ui.json` (Sigils, Packs, Shader), optional; wird bei Änderung neu gelesen |
| `HERMES_WEBUI_ALLOWED_HOSTS` | erlaubte Host-Header, kommagetrennt (prod: `webui.example.com`) |
| `HERMES_WEBUI_PUBLIC_URL` | Öffentliche Adresse, Grundlage der Redirect-URI (`https://webui.example.com`) |
| `HERMES_WEBUI_TRUSTED_PROXIES` | Adressen, deren `X-Forwarded-For` gilt (Standard: Loopback) |
| `HERMES_WEBUI_AUDIT_FILE` | Audit-Log (Standard `audit.log`, Modus 0600) |
| `HERMES_WEBUI_OIDC_ISSUER` | Adresse des OIDC-Anbieters (getestet mit Forgejo; Authorization Code mit PKCE ist Voraussetzung), z. B. `https://auth.example.com` |
| `HERMES_WEBUI_OIDC_CLIENT_ID`, `HERMES_WEBUI_OIDC_CLIENT_SECRET` | OAuth2-Anwendung beim Anbieter (vertraulicher Client, Redirect `<PUBLIC_URL>/auth/callback`, Scopes `openid profile`) |
| `HERMES_WEBUI_HIDDEN_PROVIDERS` | Anbieter-Kennungen, die diese Installation nicht zeigt (kommagetrennt); Standard: keine |
| `HERMES_WEBUI_OIDC_ALLOWED_SUB` | Erlaubte Kennungen (`sub` des ID-Tokens), kommagetrennt |

Ältere Namen gelten weiter als Alias: `FORGEJO_ISSUER`, `FORGEJO_OIDC_CLIENT_ID`, `FORGEJO_OIDC_CLIENT_SECRET`, `OIDC_ALLOWED_SUB`.

| `HERMES_KEY_*` | API-Keys der Runtimes, Namen frei über `api_key_env` in der Config |

Secrets nie in Repo, Chat oder Frontend: Umgebung oder Datei mit Modus 0600.

## Betrieb mit Docker

Ein Container mit `network_mode: host`, BFF und Frontend in einem Image, davor ein Reverse-Proxy.

```bash
git clone https://github.com/marct3797/Hermes-WebUI && cd Hermes-WebUI
bash deploy/deploy.sh          # legt ~/hermes-webui/{config,data,webui.env} an (Vorlagen: deploy/hosts.example.json, deploy/webui.env.example), startet den Container, wartet auf /healthz
```

- `deploy/deploy.sh` ist idempotent, löscht nichts und überschreibt keine vorhandene Config. Pflicht in `webui.env` (`chmod 600`): die OIDC-Werte und alle `api_key_env` der Runtimes aus der `hosts.json`; fehlt etwas, nennt das Skript die Namen und endet vor dem Start. Steht `HERMES_CONTAINER` in `webui.env`, holt es den Key eines Multiplex-Gateways aus dem Container, ohne ihn auszugeben. `WEBUI_EXTRA_HOST=name:ip` hilft, wenn der Container den OIDC-Anbieter nicht auflösen kann. Ein Beispiel-Theme legt `WITH_EXAMPLE_THEME=1 bash deploy/deploy.sh` an.
- OAuth-App beim Anbieter: Redirect-URI `https://webui.example.com/auth/callback`; `HERMES_WEBUI_OIDC_ALLOWED_SUB` ist das `sub` des Benutzers (bei Forgejo die numerische Benutzer-ID).
- Reverse-Proxy: Beispiel in `deploy/Caddyfile.snippet` (SSE ohne Pufferung, bei nginx `proxy_buffering off`).
- Rauchtest durch das BFF ohne Login: ein Wegwerf-Container mit `HERMES_WEBUI_ENV=dev`, `AUTH_MODE=none` auf `127.0.0.1:8421`, dann `python backend/devtools/smoke_bff.py --agent delta`.
- Aktualisieren: Branch holen, `bash deploy/deploy.sh` erneut.

## Lizenz

GNU Affero General Public License v3.0 (`AGPL-3.0-only`), Text in [LICENSE](LICENSE). Wer eine veränderte Fassung als Netzwerkdienst anbietet, muss den Nutzern deren Quelltext anbieten (Abschnitt 13 der Lizenz). Lizenzen der Abhängigkeiten: MIT, BSD, ISC, Apache-2.0, PSF-2.0, MPL-2.0 und die Schriften unter OFL-1.1; vor einer Veröffentlichung gesondert prüfen.
