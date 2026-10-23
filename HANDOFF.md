# Übergabe an Codex (Stand 2026-10-23)

Arbeitsnotiz für den nächsten Entwickler, hier direkt im Repo, damit nichts am Chat hängt. Sie nennt Marcs echte Adressen und gehört vor der Veröffentlichung auf GitHub gekürzt; das entscheidet Marc.
Mehr Hintergrund steht im Übergabe-Dokument: <https://claude.ai/artifact/4aQQjk9DPoMo2trXfJiJJH>. Zum Loslegen reicht diese Datei.

## 1. Auftrag

Marc baut eine persönliche WebUI für seine Hermes-Agents (Portfolio-Projekt, später öffentlich auf GitHub). Sie muss darum **generisch** bleiben: beliebige Hermes-Instanzen, Marketplaces und Gedächtnis-Anbieter per Config, Sigils und Theme einstellbar. Keine Hostnamen, Profile, Ports oder Pfade von Marc im Code; alles kommt aus `hosts.json`, `memory.json`, `ui.json` oder Umgebungsvariablen. Beispiele und Doku dürfen sein Setup zeigen.

Ziel ist der volle Umfang der Hermes-Funktionen laut Doku, auf mehreren Hosts (VPS „Hikari“, Laptop) und Runtimes (Hermes, Claude Code, OpenCode, Antigravity). Automatisierte Tests gehen vor manuellem Prüfen.

## 2. Regeln von Marc (verbindlich)

- Zuständig ist nur der WebUI-Code. Caddy, Zertifikat, DNS, Hindsight, Agents, Profile und SOULs laufen schon. Keine Infrastrukturfragen stellen.
- Nicht überstürzen: bei größeren Bauten erst real prüfen, den Plan mit Marc besprechen, nach seinem OK bauen. Nie fragen, was er schon beantwortet hat (vorher Thread und Chat lesen).
- Die Agents arbeiten autonom (Freigaben aus, Terminal lokal). Das ist Absicht, alles hängt hinter Tailscale. Nicht widersprechen, Sicherheitshinweise höchstens einmal kurz.
- **Löschen ist streng verboten**, nur innerhalb des Projekts für den Workflow erlaubt. Prüfen, Lesen und Ausführen auf Laptop und VPS ist sonst erlaubt. Lokale Permission-Checks nie umgehen.
- Keys nur als Umgebungsvariable, nie im Chat, nie in Argumenten oder Logs.
- Marc schreibt Deutsch und will kurze, fokussierte Antworten. „Gefixt“ erst melden, wenn es nachweislich läuft (nachgestellt mit echtem Hermes-Code oder den echten Daten, nicht nur gegen den Mock).
- Den alten „Agent-Hub“ (Version 1) ignorieren, die WebUI wurde neu gebaut.
- Claude-Abo-OAuth darf nicht in einer Fremd-Oberfläche laufen: für Claude Code nur die echte CLI im Terminal oder ein API-Key.
- **Deploy führt Marc aus.** Ihm den Befehl als Kopierblock geben (kein `set -e`, in `bash -c`, ohne Klartext-Keys) und den erwarteten „Stand `<commit>`“ nennen. Kopierblöcke vorher testen.

## 3. Stand

| Was | Wert |
|---|---|
| Repo | <https://github.com/marct3797/Hermes-WebUI> |
| Branch / PR | `claude/project-thread-2mp7e3`, PR #4 (Basis `claude/webui-design-v2`, PR #3) |
| Letzter Code-Commit | `3581c6b` (danach nur Doku) |
| Tests | Backend 340, Frontend 269, `tsc` sauber; CI (Jobs `backend`, `frontend`) grün |
| Live | <https://agents.thiel.digital> (nur im Tailnet, Forgejo-Login `marc`), Container `hermes-webui` auf Hikari (`100.100.1.1`, Benutzer `tenjin`) |
| Verzeichnisse auf Hikari | Checkout `~/Hermes-WebUI`; Config, Daten und `webui.env` in `~/hermes-webui/` |
| Gebauter Stand | steht unten links in der Seitenleiste als „Stand `<commit>`“ |

**Von Marc bestätigt (2026-10-23):**
- Räume funktionieren: Ryujin fragte Omoikane etwas, beide antworteten (19:33 UTC). Ursache davor war, dass jedes `@user` den Raum beendete (Commit `5ad1d27`).
- Laptop erreichbar: Das Problem war die Tailscale-ACL (Hikari → Laptop `:8642` lief in Timeout). Marc ließ sie von seinen Agents anpassen, danach liefert `curl` von Hikari auf `/health` HTTP 200.

**Noch nicht bestätigt (bei Marc nachfragen, nicht raten):**
- Dass der Laptop nach dem Deploy unter Hosts „online“ zeigt (Key `HERMES_KEY_LAPTOP` liegt auf Hikari, Länge 64).
- Die Anbieter-Seite mit den echten 9 Profilen und der neue Gedächtnis-Graph.
- Alles, was das echte Netz braucht: Codex-Gerätecode-Anmeldung, echte Hindsight-Antwortformen.

**Gebaut:** Chat (Streaming, Tool-Karten, Freigaben, Fork/Fortsetzen), Cockpit, Inbox (nur echte Einträge), Hosts, Räume, Gedächtnis (Hindsight, Graph als Landkarte), SOUL und Profil, Anbieter-Hauptseite `/providers`, Keys und Nutzung je Agent, Skills, Werkzeuge, System-Diagnose, Darstellung (`ui.json`), Sicherheit (OIDC, Step-up, Audit-Log ohne Werte), Betrieb (`deploy/*.sh`, Docker mit `network_mode: host`).
**Nicht gebaut:** Host-Dienst für Coding-CLIs, Kanban (Seitenleiste zeigt „PHASE 3“), Werkzeuge/MCP/Plugins je Host, Marketplaces, Workspace-Browser pro Chat, Git-Plattformen, Cron und Logs, Restkontingente der Konten.

## 4. Schnellstart

```bash
git clone https://github.com/marct3797/Hermes-WebUI && cd Hermes-WebUI
git checkout claude/project-thread-2mp7e3        # PR #4; weiter auf diesem Branch oder davon abzweigen
```

Backend (Python ≥ 3.11) und Frontend (Node 22):

```bash
cd backend && python -m venv .venv && . .venv/bin/activate && pip install -e '.[dev]'
cp hosts.example.json hosts.json                   # Hosts, Runtimes, Agents; Keys per api_key_env
uvicorn devtools.mock_hermes:app --port 8642 &     # Hermes-Mock (Key: dev-key)
uvicorn app.main:app_factory --factory --port 8000
# zweites Terminal:
cd frontend && npm ci && npm run dev               # Proxy /bff und /auth -> :8000
```

Mock-Stack für ganze Seiten (ohne echte Instanz, aus `backend/`): `devtools.mock_hermes:app` auf 8642, `devtools.mock_dashboard:app` auf 9122 (Token `dash-token`), `devtools.mock_hindsight:app` auf 8888 (mit `MOCK_GRAPH_NODES=150 MOCK_GRAPH_KINDS=0` ein Graph wie in Marcs echtem Gedächtnis). Das BFF liest `HERMES_WEBUI_HOSTS_FILE`, `HERMES_WEBUI_MEMORY_FILE`, `HERMES_WEBUI_ROOMS_DB`, `HERMES_WEBUI_STATIC_DIR` (Frontend-Build), `HERMES_WEBUI_SOUL_DIR`, `HERMES_WEBUI_AUDIT_FILE`. Alle Variablen stehen in `README.md` (Abschnitt Betrieb).

## 5. Prüfen

Die CI führt genau diese Schritte aus; vor jedem Push lokal laufen lassen:

```bash
cd backend  && python -m pytest -q                 # 340 Tests, asyncio_mode=auto
cd frontend && npx tsc --noEmit && npx vitest run && npm run build   # 269 Tests
```

- **Gegen echten Hermes-Code lokal** (Räume, Anbieter-Matrix, Modellliste, Start der Anthropic-Anmeldung): Anleitung in `backend/devtools/real/README.md` (Skripte `fakellm.py`, `gw.sh`, `drive.py`, `prov.py`). Der Hermes-API-Server startet nur mit einem `API_SERVER_KEY` von mindestens 16 Zeichen. PyPI hat Hermes bis 0.19.0; Hikari läuft 0.21.6, der Laptop 0.22.4.
- Prozesse in der Sandbox mit `fuser -k <port>/tcp` stoppen, nie `pkill -f` (beendet die eigene Shell).
- Der Tab-Titel wird in einem Effekt gesetzt; Tests warten darauf mit `waitFor` (war ein wackliger CI-Test).
- Neue Seiten bekommen Tests gegen `frontend/src/test-backend.ts` (Attrappe des BFF), neue BFF-Routen Tests gegen die Mocks in `backend/devtools/`.

## 6. Karte des Codes

Browser spricht nur mit dem BFF; das BFF spricht mit Hermes (Agent-API), dem Hermes-Dashboard und dem Gedächtnis und hält alle Keys.

| Pfad | Aufgabe |
|---|---|
| `backend/app/hosts.py`, `registry.py` | Hosts aus `hosts.json`, Adapter je Runtime; `kind` (lokal/remote) ist nur Anzeige |
| `backend/app/adapters/hermes.py` | Hermes-Agent-API, Fehlertexte mit Adresse und Grund |
| `backend/app/rooms.py` | Raum-Engine (normale Runs je Mitglied, `build_prompt`, SQLite) |
| `backend/app/dashboard.py`, `routes/dashboard.py` | Brücke zum Hermes-Dashboard (SOUL, Profile, Keys, Modelle, OAuth) |
| `backend/app/providers.py` | `ACCOUNTS` (Codex, Claude, OpenCode Go), Matrix, Modelllisten |
| `backend/app/memory.py` | Gedächtnis-Anbieter hinter einer Schnittstelle, Hindsight zuerst |
| `frontend/src/pages`, `components` | Seiten und Bausteine; Styles in `src/styles/*.css`; Router ohne Bibliothek in `src/router.ts` |
| `frontend/src/components/providers/` | Anbieter-Hub (`HostProviders`, `LoginFlow`, `ModelEditor`, `AccountPanel`) |
| `frontend/src/graphCluster.ts`, `graphLayout.ts` | Gedächtnis-Graph (Louvain-Gruppen, Gerüst, Layout) |
| `deploy/` | `deploy.sh`, `dashboard.sh`, `profile-keys.sh`, `add-host.sh`, Beispiel-Configs, Caddy-Auszug |
| `backend/devtools/` | Mocks (`mock_hermes`, `mock_dashboard`, `mock_hindsight`), `smoke_bff.py`, `real/` |

URL-Schema: `/` Cockpit, `/inbox`, `/hosts`, `/rooms[/<id>]`, `/memory`, `/providers`, `/system`, `/settings`, `/h/<host>/<runtime>/<agent>/<modul>[/<id>]` (Module `chat`, `soul`, `providers` = Keys und Nutzung, `skills`, `tools`, `profil`). Host-Ebene des BFF: `/bff/h/<host>/<runtime>/_provider-matrix` (Name mit `_`, damit `{agent}` ihn nicht schluckt).

## 7. Offene Aufgaben in Reihenfolge

1. **Bestätigungen von Marc einholen.** Er führt den Deploy aus:
   ```
   ssh -t tenjin@100.100.1.1 "bash -c 'cd ~/Hermes-WebUI && git pull origin claude/project-thread-2mp7e3 && bash deploy/deploy.sh'"
   ```
   Danach muss unter Hosts der Laptop „online“ zeigen und die Seitenleiste den neuen Stand nennen. Dann `/providers` mit den echten Profilen und den Graphen ansehen lassen. Keine Code-Arbeit, aber alles Weitere baut darauf auf.
2. **Host-Dienst `hostd` bauen** (Plan in Abschnitt 8). Marc hat ihn am 2026-10-23 im Grundsatz freigegeben, verlangt aber, dass er **im Repo und im Build** liegt, damit ihn später GitHub-Nutzer haben. Die Reihenfolge der Schritte kurz mit Marc bestätigen, dann bauen.
3. **Gegen die echte Instanz prüfen:** Codex-Gerätecode-Anmeldung (`/providers`), Matrix mit den 9 Profilen, Hindsight-Formen (`/bff/memory/<id>/diagnose` zeigt Abweichungen; Graph hatte 150 Knoten und 7.603 Kanten ohne Faktenart), Graph mit echten Daten.
4. **Laptop-Dashboard anbinden**, wenn Marc die Anbieter-Tabelle des Laptops will: dort `hermes dashboard` starten, dann auf Hikari `bash deploy/add-host.sh laptop Laptop 100.100.3.4 --dashboard-port <port>` (ergänzt nur das Dashboard, überschreibt nichts; fragt den Token still ab) und danach erneut den Deploy. Und Tailscale-ACL für den Dashboard-Port ergänzen lassen.
5. **Kleinkram:** `/auth/callback?code=…` aus dem BFF-Zugriffslog filtern; Hermes wirft auf Hikari bei `/v1/skills` einen TypeError (`_find_all_skills() got an unexpected keyword argument 'include_editorial'`), die WebUI weicht schon auf das Dashboard aus, ein Hinweis an Hermes wäre gut.
6. **Weitere Funktionen**, Reihenfolge mit Marc klären (Vorschlag): Kanban (Forgejo-Issues zu Tasks je Profil auf dem VPS), Seite für Werkzeuge/MCP/Plugins je Host, Marketplaces (Hermes, anthropics/skills, Claude-Code-Plugin-Marketplaces, MCP-Registry, awesome-mcp-servers), Workspace-Browser pro Chat (abgesichert), Git-Plattformen, Cron und Logs. Recherche dazu: <https://claude.ai/artifact/V1Wign1FQ7fuhmdANacXjG>.

Arbeitsweise bei jeder neuen Funktion: erst real prüfen, dann den Plan mit Marc besprechen, dann bauen, mit Tests belegen, am Ende den Deploy-Kopierblock samt erwartetem „Stand `<commit>`“ liefern.

## 8. Plan Host-Dienst (`hostd`)

Ziel: Codex, Claude, OpenCode und Antigravity auf jedem Host als Terminal in der WebUI ansteuern. Das Hermes-Dashboard kann das nicht (`/api/pty` führt nur sein eigenes TUI aus). Claude-Abo läuft ausschließlich in der echten CLI im Terminal.

- **Dienst** in `hostd/` (Python, eigene `pyproject.toml`): ein Prozess je Host, systemd-Benutzerdienst ohne Root, installiert mit `deploy/install-hostd.sh` (eigene venv per `pip install`). Bindet nur an die Tailnet-Adresse aus `hostd.json`, erlaubt nur CLIs aus einer Liste in dieser Datei (Name, Befehl, erlaubte Arbeitsordner); freie Shell nur per Schalter.
- **Schnittstelle:** `GET /v1/info` (Version, erkannte CLIs), `POST /v1/terminals` (CLI, Ordner, Größe), `GET /v1/terminals`, `WS /v1/terminals/<id>/stream` (Bytes in beide Richtungen, Größe ändern), `DELETE /v1/terminals/<id>`. Terminal läuft weiter, wenn der Browser trennt; Puffer (etwa 256 KB) zum Wiederverbinden. Bearer-Token aus einer Umgebungsvariable, Herkunftsprüfung, Rate-Limit.
- **BFF:** je Host in `hosts.json` ein Eintrag `hostd: { base_url, token_env }`; Routen `/bff/h/<host>/_terminals…` mit Anmeldung, Step-up zum Öffnen, WebSocket-Weiterleitung, Audit-Log ohne Inhalt (Host, CLI, Dauer). Ohne Eintrag zeigt die WebUI „Host-Dienst nicht eingerichtet“.
- **Oberfläche:** Seite „Terminal“ je Host mit xterm.js; Knöpfe „CLI öffnen“ in der Anbieter-Tabelle und im Abschnitt „Coding-CLIs“ (`frontend/src/pages/ProvidersHubPage.tsx`, Konstante `CODING_CLIS`); auf dem Handy Tastenleiste (Esc, Tab, Strg, Pfeile).
- **Tests:** Pytest für `hostd` mit echtem Pseudo-Terminal, BFF-Weiterleitung gegen einen Mock-Dienst, Vitest mit gefälschtem WebSocket, eigener CI-Job `hostd`.
- **Reihenfolge:** Dienst mit Tests, BFF-Routen, Terminal-Seite, Anbindung in der Anbieter-Tabelle, Installationsskript und README, zuletzt Installation auf dem Laptop (Marc, als Kopierblock) und auf Hikari.

## 9. Fakten über die echte Instanz

- **Hikari:** angebunden wird nur das Container-Gateway `hermes-agents` auf `127.0.0.1:9121` mit 9 Profilen unter `/p/<profil>/` (benzai, default, inari, kaze, omoikane, raiden, ryujin, sora, yume) und das Dashboard auf `127.0.0.1:9122`. Das Host-Gateway von `tenjin` auf 8642 wird **nicht** angebunden. Jedes Profil außer `default` hat einen eigenen `API_SERVER_KEY`; `deploy/profile-keys.sh` trägt sie in `webui.env` ein (Marc führt aus). Räume liegen in `~/hermes-webui/data/rooms.db`.
- **Gedächtnis:** Hindsight auf kage (`100.100.1.2:8888`, eine Bank `hermes`), konfiguriert in `memory.json`.
- **Laptop** (`tuxedo-os`, Benutzer `marct`, Tailscale `100.100.3.4`): Hermes 0.22.4, nur Profil `default`, API auf `100.100.3.4:8642` (`API_SERVER_ENABLED=true`, `API_SERVER_HOST=100.100.3.4`, `API_SERVER_KEY` ≥ 16 Zeichen in `~/.hermes/.env`). Läuft als systemd-Benutzerdienst `hermes-gateway.service`. Fällt der Listener auf `127.0.0.1` zurück, die Adresse im Dienst statt in der `.env` setzen (`Environment=API_SERVER_HOST=100.100.3.4` in einem Drop-in). Die Zeile in der `.env` wurde einmal durch einen Rückbau-Befehl eines anderen Threads entfernt (`sed -i '/^API_SERVER_HOST=…/d'`), nicht durch Hermes; diesen Rückbau nicht wiederholen.
- **Host eintragen:** `bash deploy/add-host.sh <id> "<Name>" <adresse> [--port N] [--profile NAME] [--dashboard-port N]`; Key still abfragen oder per Pipe vom Host (`sed -n 's/^API_SERVER_KEY=//p' ~/.hermes/.env | tail -n 1 | ssh tenjin@100.100.1.1 "bash -c 'cd ~/Hermes-WebUI && bash deploy/add-host.sh laptop Laptop 100.100.3.4'"`). Das Skript überschreibt nie etwas und gibt keine Werte aus. Danach Deploy.
- **Erreichbarkeit prüfen:** `ssh tenjin@100.100.1.1 "curl -sS -m 5 -o /dev/null -w 'HTTP %{http_code}\n' http://100.100.3.4:8642/health"`. `/health` braucht keinen Key; `curl -s` allein verschweigt Fehler. Timeout statt „abgelehnt“ trotz funktionierendem `tailscale ping` heißt: Paket wird verworfen, meist Tailscale-ACL (so war es hier).
- **Hermes-API (0.21.6):** `POST /v1/runs` nimmt `input`, `instructions`, `session_id`, `conversation_history`; die `session_id` steht erst in `GET /v1/runs/{id}`. Ereignisse: `message.delta`, `reasoning.available`, `run.completed`, `run.failed`, `tool.started`, `tool.completed`, `approval.request`, `approval.responded`. Der Strom trägt weder Argumente noch Ausgabe eines Tool-Aufrufs, beides steht im Session-Verlauf. `/v1/capabilities` nennt `features` und `endpoints`.
- **Hermes-Dashboard:** `hermes dashboard --port N --no-open --skip-build`, jede `/api/`-Route braucht den Header `X-Hermes-Session-Token`, das Profil kommt als `?profile=`. Genutzt: `/api/profiles`, `/api/env`, `/api/providers/oauth` (`start`, `poll`, `submit`, `cancel`), `/api/model/options`, `PUT /api/profiles/{name}/model`. Anmelde-Sitzung: `pending`, `approved`, `error`, `expired`.
- **Hikari-Logs:** die Webhook-Plattform meldet alle 5 Minuten „Could not bind 0.0.0.0:8642“; der Hindsight-Prefetch läuft je Run in ein 10-Sekunden-Zeitlimit. Beides Hermes-Seite.
- **Laptop-Remote-Control-Sitzungen** laufen im Auto-Modus und blockieren vieles. Blockierte Befehle als sicheren Kopierblock an Marc geben.
