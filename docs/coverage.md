# Abdeckung: was Hermes nativ bietet und was die WebUI davon abbildet

Stand: Hermes Agent v0.22.5 (2026.9.24), Commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e`. Zwei Quellen, getrennt ausgewiesen:

- **Routen** (maschinell, reproduzierbar): jede Route, die Dashboard, Plugins und Gateway-API von Hermes anbieten.
- **Funktionsbereiche**: die Gliederung der offiziellen Dokumentation (https://hermes-agent.nousresearch.com/docs/llms.txt, Abschnitte „Core Features“,
  „Automation“, „Media & Web“, „Messaging Platforms“, „Integrations“). Die Zuordnung zur WebUI ist von Hand gemacht und mit den Routen belegt.

„Abgebildet“ heißt: es gibt eine Seite oder Funktion der WebUI dafür. Es heißt nicht, dass jede Option der Funktion erreichbar ist.

## Reproduzierbare Zahlen

```
cd backend
python -m devtools.check_upstream /pfad/zu/hermes-agent --coverage
```

Von 390 Routen (Modul, Methode, Pfad) nutzt das BFF 99 pfadgenau. Nach Modul, wenig genutzte zuerst:

| Modul | Routen | genutzt | Inhalt |
|---|---:|---:|---|
| `web_routers/ops.py` | 28 | 2 | Gateway start/stop (genutzt); Doctor, Backup, Import, Checkpoints, Hooks, Webhooks, Pairing, Gedächtnis zurücksetzen, Credential-Pool offen |
| `web_routers/git.py` | 21 | 0 | Git im Dashboard (die WebUI nutzt dafür `hostd`) |
| `web_routers/local_models.py` | 18 | 0 | lokale Modelle: Katalog, Hardware, Download, Server |
| `web_routers/files.py` | 18 | 0 | Dateien im Dashboard (die WebUI nutzt dafür `hostd`) |
| `web_routers/messaging.py` | 11 | 7 | Messaging-Plattformen: Liste, Konfiguration, Test, Telegram-Einrichtung. **Nicht**: WhatsApp-Kopplung (4 Routen, QR-Code) |
| `web_routers/audio.py` | 10 | 0 | Sprache: TTS, STT, Live-Sprachmodus |
| `web_routers/actions.py` | 8 | 2 | Gateway neu starten (genutzt), Aktions-Status (genutzt); **nicht**: leeren (Drain), migrieren, Hermes-Update |
| `web_routers/chat_ws.py` | 5 | 0 | Terminal-Chat per WebSocket (die WebUI nutzt die Gateway-API) |
| `web_routers/delegation.py` | 4 | 0 | Delegation: Routing, Backends, Modellzuordnung |
| `web_routers/memory_providers.py` | 3 | 0 | Einrichtung der Hermes-Gedächtnis-Anbieter |
| `web_routers/status.py` | 20 | 2 | Status (Gateway-Zustand genutzt), Gesundheit, Systemwerte, Curator, Lerngraph |
| `web_routers/tools.py` | 12 | 8 | Toolsets, Anbieter, Keys, Modelle; **bewusst nicht**: Terminal-Backend setzen, `post-setup`, Computer-Use-Rechte, siehe unten |
| `web_routers/models.py` | 7 | 1 | Hilfsmodelle, Mixture of Agents, empfohlenes Standardmodell |
| `plugins/kanban` | 48 | 18 | Kanban |
| `web_routers/profiles.py` | 20 | 6 | Profile anlegen, löschen, umbenennen, exportieren, importieren |
| `web_routers/dashboard_ui.py` | 16 | 3 | Plugin-Verwaltung, Themes, Schrift |
| `web_routers/sessions.py` | 18 | 6 | Sitzungen exportieren, importieren, aufräumen, Statistik |
| `gateway/api_server` | 46 | 20 | Läufe, Sitzungen, Jobs; ungenutzt u. a. OpenAI-Schnittstellen, Artefakte, Raum-Mitglieder |
| `web_routers/mcp.py` | 12 | 5 | MCP testen, aktivieren, entfernen, OAuth |
| `web_routers/config_env.py` | 15 | 7 | eigene Endpunkte, Defaults, Egress |
| `web_routers/cron.py` | 13 | 12 | Zeitpläne |
| `web_routers/skills.py` | 13 | 13 | Skills |

Pfadgenau heißt: ein Pfad zählt als genutzt, auch wenn nur eine seiner Methoden gebraucht wird.

## Funktionsbereiche

| Bereich (Hermes-Doku) | Stand in der WebUI | Beleg |
|---|---|---|
| Chat, Läufe, Freigaben, Steuern, Stoppen | abgebildet | Gateway `/v1/runs*` |
| Sitzungen | teilweise: Liste, Fortsetzen, Umbenennen, Löschen, Fork, Suche. Fehlt: Export, Import, Aufräumen, Statistik, Zeitachse | `sessions.py`: 6 von 18 |
| Profile (`Profiles`) | teilweise: SOUL, Beschreibung, Standardmodell. Fehlt: anlegen, löschen, umbenennen, Import/Export, aktives Profil | `profiles.py`: 6 von 20 |
| Konfiguration (`Configuration`) | abgebildet über das Schema (alle Felder, Geheimnisse ausgenommen). Fehlt: Roh-YAML, Migration, Standardwerte | `config_env.py`, `analytics.py` |
| Modelle und Anbieter (`Providers`) | teilweise: Keys, Anmeldung, Modellwahl, Nutzung. Fehlt: eigene Endpunkte, Credential-Pools, lokale Modelle, Hilfsmodelle und Mixture of Agents als eigene Seite (einzelne Felder stehen im Einstellungs-Editor) | `config_env.py`, `local_models.py`, `models.py` |
| Werkzeuge (`Tools`) | ja: Gruppen ein-/ausschalten, Anbieter wählen (bei `web` getrennt für Suche und Extraktion), Werkzeug-Keys setzen (nur Variablen, die die Gruppe selbst nennt, nie angezeigt), Bild-/Video-Modell wählen, Terminal-Backend anzeigen. **Bewusst nicht**: Terminal-Backend umstellen, `post-setup` starten, Computer-Use-Rechte vergeben (Hermes prüft das serverseitig nicht) | `tools.py`: 8 von 12; `routes/tools.py`, `ToolsetPanel.tsx` |
| Skills (`Skills System`) | abgebildet. Fehlt: Curator | `skills.py`: 13 von 13 |
| Gedächtnis (`Memory`, `Memory Providers`) | **nur Hindsight** über einen eigenen Client. Fehlt: das eingebaute `MEMORY.md`/`USER.md`, Auswahl und Einrichtung der Hermes-Anbieter | `memory_providers.py`, `ops.py` |
| MCP | teilweise: Liste, Katalog, Installieren. Fehlt: Testen, Aktivieren, Entfernen, OAuth | `mcp.py`: 5 von 12 |
| Plugins | teilweise: Hub, Katalog, Installieren. Fehlt: aktivieren, deaktivieren, aktualisieren, Sichtbarkeit | `dashboard_ui.py` |
| Zeitpläne (`Cron Jobs`) | abgebildet (12 von 13 Routen); `POST /api/cron/fire` fehlt. Ob sich Skript-Jobs ohne Agent (`no_agent`) anlegen lassen, ist nicht geprüft, sie werden nur angezeigt | `cron.py`, `app/cron.py` |
| Kanban | teilweise (18 von 48): Board, Aufgaben, Kommentare, Verknüpfungen. Fehlt: Anhänge, Zerlegen/Spezifizieren/Schätzen, Läufe prüfen und beenden, Worker, Boards importieren/exportieren/wechseln, Orchestrierung | `plugins/kanban` |
| Hooks, Webhooks, Pairing | nicht abgebildet | `ops.py` |
| Delegation, Subagenten | nicht als Seite (Felder im Editor) | `delegation.py` |
| Messaging-Plattformen (35 in der Doku, 32 im Dashboard 0.22.5) | **ja**: Liste mit Zustand, Variablen setzen/löschen (Tokens nie sichtbar), ein-/ausschalten, Verbindung prüfen, Telegram-Assistent. **Nicht**: WhatsApp koppeln (QR-Code), Heimatkanal setzen, Plattform-Plugins verwalten | `routes/messaging.py`, `MessagingPage.tsx`; `messaging.py`: 7 von 11 |
| Gateway-Betrieb | teilweise: Zustand, starten, anhalten, neu starten (Unterbrechen nur nach Bestätigung), Protokoll des Befehls. **Nicht**: leeren (Drain), migrieren | `actions.py`: 2 von 8, `ops.py` |
| Sprache (`Voice Mode`, `Text-to-Speech`) | nicht abgebildet | `audio.py`: 0 von 10 |
| Browser, Vision, Bildgenerierung | Bild-Anhänge im Chat (bis zu 4 je Nachricht); der Rest nur über Einstellungsfelder | `routes/agents.py`, Schema |
| Artefakte im Chat (`Deliverable Mode`) | nicht abgebildet | Gateway `/v1/artifacts/*` |
| Betrieb: Doctor, Backup/Import, Checkpoints, Update, Sicherheitsprüfung | nicht abgebildet (die WebUI hat eine eigene Diagnose pro Agent) | `ops.py`, `actions.py` |
| Status, Gesundheit, Systemwerte, Curator, Lerngraph | nicht abgebildet | `status.py`: 1 von 20 |
| Räume und Bots | **eigenes Konzept der WebUI** (`rooms.db`), nicht die Raum-Funktion von Hermes (`/v1/room-members/*`) | `routes/rooms.py` |
| Themes, Schriften, Sprachpakete von Hermes | nicht abgebildet; die WebUI hat eigene Themes (`ui.json`) | `dashboard_ui.py` |
| Achievements, Pets | nicht abgebildet | `plugins/hermes-achievements` |
| OpenAI-kompatible Schnittstellen (`/v1/chat/completions`, `/v1/responses`) | bewusst nicht genutzt (die WebUI nutzt die Läufe-Schnittstelle) | Gateway |
| ACP, Hermes als Python-Bibliothek, Editor-Anbindung | kein Thema einer Weboberfläche | |

## Risiken für den Betrieb mit beliebigen Installationen

1. **Dashboard auf einem anderen Rechner.** Geprüft an einem echten Dashboard (0.22.5, Loopback): Hermes vergleicht den Rechnernamen im `Host`-Header (Port egal): `127.0.0.1`, `localhost` gehen, jeder andere Name liefert 400 „Invalid Host header“. Bindet das Dashboard nicht auf Loopback, schaltet Hermes eine Anmeldeschranke ein (Sitzung oder Bearer-Token eines Anbieters; `--insecure` ist wirkungslos, siehe `hermes dashboard --help`). Der Sitzungs-Header der WebUI genügt dann nicht. **Der unterstützte Weg ist Loopback plus Tunnel:** Dashboard auf `127.0.0.1` des Hosts lassen, per `ssh -N -L 127.0.0.1:19119:127.0.0.1:9119 <benutzer>@<host>` auf den WebUI-Rechner führen und `http://127.0.0.1:19119` eintragen (`add-host.sh --dashboard-url`). Die WebUI meldet die drei Fälle (falscher Rechnername, eigene Anmeldung verlangt, Token abgelehnt) jetzt mit diesem Ausweg. Nicht getestet: die Antwort der Schranke selbst an einer nicht-loopback gebundenen Instanz (aus dem Quelltext gelesen: 401 oder Weiterleitung auf `/login`; beides ist abgefangen).
2. **Antwortformen.** Die Lese-Routen sind gegen echte Antworten von 0.22.5 getestet (`tests/test_contract_hermes_0_22_5.py`, Fixture aus einem Sandbox-Dashboard). Nicht aufgenommen sind Schreib-Routen und Zustände mit Daten (laufende Sitzungen, eingerichtete Anbieter, Zeitpläne): das frische Sandbox-HOME hat keine. Es gibt weiterhin keine Matrix über mehrere Hermes-Versionen.
3. **Run-Strom.** Korrektur: `run.stopping` und `run.interrupted` sind Lauf-*Status* (`GET /v1/runs/{id}`), keine Stromereignisse; `runStore.ts` behandelt sie beim Nachfragen (Zeilen 154 bis 172). Nur `run.queued` kommt als Ereignis (als `unknown`), danach setzt die Wiederaufnahme per Statusabfrage fort. Aus dem Quelltext gelesen, nicht mit einem laufenden Gateway-Neustart geprüft.
4. **Verwaltete Konfiguration.** Hermes kennt „Managed Scope“ (vom Administrator festgelegte, nicht änderbare Werte). Wie der Einstellungs-Editor ein abgelehntes Feld zeigt, ist nicht getestet.
5. **Oberfläche nur auf Deutsch.** `lang="de"`, alle Texte im Code, keine Übersetzungsschicht. Für ein öffentliches Projekt ist das eine Einschränkung; die englische README ersetzt sie nicht.
6. **Keine Prüfung im echten Browser** für die Seiten „Kanban“ und „Hermes-Einstellungen“ (nur jsdom).
7. **CI** prüft nur Ubuntu; `hostd` unter macOS ist beworben, nicht geprüft.

## Reihenfolge, die ich vorschlage

**P1: ohne das ist es keine vollständige Oberfläche für Hermes**
1. ~~Messaging-Plattformen und Gateway-Betrieb~~ umgesetzt und gegen ein echtes Dashboard geprüft (`devtools/real/contract_messaging.py`). Offen daraus: WhatsApp-Kopplung (QR), Drain.
2. ~~Werkzeuge konfigurieren und Werkzeug-Keys setzen~~ umgesetzt und gegen ein echtes Dashboard geprüft (`devtools/real/contract_tools.py`).
3. Hermes-Gedächtnis: eingebautes `MEMORY.md`/`USER.md` und die Anbieter-Auswahl, statt nur Hindsight.
4. Profil-Lebenszyklus: anlegen, löschen, umbenennen, Import/Export.
5. Betrieb: Status/Gesundheit, Doctor, Backup, Update-Prüfung.
6. ~~Dashboard-Anmeldeschranke für entfernte Hosts~~ geklärt und gegen ein echtes Dashboard geprüft (Punkt 1 oben): Tunnel statt Adresse.
7. ~~Vertragstests gegen 0.22.5~~ für die Lese-Routen aufgenommen; Run-Strom war falsch eingeschätzt (Punkt 3 oben).

**P2**
8. Modelle: eigene Endpunkte, Credential-Pools, lokale Modelle, Hilfsmodelle, Mixture of Agents, Delegation.
9. MCP und Plugins verwalten; Kanban in der Tiefe; Sitzungsverwaltung (Export, Import, Aufräumen).
10. Hooks, Webhooks, Pairing; Sprache.

**P3**
11. Curator, Lerngraph, Achievements, Pets, Themes; Artefakte im Chat; Computer Use; Egress und Managed Scope anzeigen.
12. Übersetzungsschicht für die Oberfläche (Englisch zuerst).

## Was die WebUI bei Werkzeugen bewusst nicht durchreicht

Aus dem Hermes-Quelltext (0.22.5, `hermes_cli/web_routers/tools.py`, `config_env.py`) gelesen und am Sandbox-Dashboard bestätigt:

- `PUT /api/env` schreibt **jeden** Variablennamen, der nicht auf einer kurzen Sperrliste steht (nicht gesperrt z. B. `TERMINAL_SSH_HOST`). Die Beschränkung „nur Anbieter-Keys“ ist reine Client-Logik. Die WebUI schreibt Werkzeug-Keys deshalb nur über `PUT /api/tools/toolsets/{name}/env` und prüft vorher selbst, dass der Name zur Gruppe gehört.
- `POST /api/env/reveal` liefert jeden Wert aus der `.env` im Klartext (Limit: 5 Aufrufe je 30 s für den ganzen Prozess). Nicht durchgereicht.
- `PUT /api/tools/terminal/backend` kann das Terminal auf `local` (keine Isolation) oder `ssh` stellen. Nicht durchgereicht, nur angezeigt.
- `POST .../post-setup` und `POST /api/tools/computer-use/permissions/grant` führen Installationen bzw. Systemdialoge aus. Nicht durchgereicht.
- Beim Einschalten kann Hermes selbst eine Installation starten. Im Quelltext prüft es das nur für `cua_driver`; die WebUI verlangt deshalb für Anbieter mit `post_setup` und Status `needs_setup` eine ausdrückliche Zustimmung. Das ist ein bewusst zu weit gefasster Schutz: Bei `web` (Anbieter `ddgs`) fragt sie, obwohl Hermes dort nichts installiert.
- Werkzeug-Keys können über die WebUI gesetzt, aber nicht gelöscht werden (Hermes überspringt leere Werte). Löschen geht im Hermes-Dashboard oder per `hermes config`.

## Was bei Messaging und Gateway bewusst anders ist als in Hermes

- **Neustart.** Hermes startet das Gateway über das Dashboard immer mit `--interrupt` neu und prüft nicht, ob Sitzungen laufen. Die WebUI liest vorher `active_sessions` und `gateway_busy` und verlangt bei laufenden Sitzungen eine ausdrückliche Bestätigung. Das ist ein Lesen-dann-Handeln (kurze Lücke zwischen Prüfung und Befehl).
- **„Gestartet“ ist nicht „läuft“.** Hermes startet nur einen Prozess; die WebUI fragt danach Zustand und Protokoll ab, schwärzt Zeilen mit Geheimnissen und zeigt Exit-Code und die letzten Zeilen.
- **Stilles Nichtschreiben.** Ist die `.env` gesperrt, antwortet Hermes `ok` und schreibt nichts (Quelltext: `env_write_refusal`). Das BFF liest zurück und meldet `502`, wenn Variable oder Schalter nicht angekommen sind.
- **Telegram-Assistent.** Das Bot-Token bleibt im Dashboard-Prozess. Den Dienst von Nous (`setup.hermes-agent.nousresearch.com`) ruft Hermes selbst auf; **dieser Ablauf ist nicht gegen den echten Dienst getestet**, weil er einen Bot bei Telegram anlegen würde. Getestet sind BFF und Oberfläche gegen ein Mock-Dashboard, die Route-Formen gegen den Quelltext.
- **Zustand nur im Dashboard-Prozess.** Telegram-Kopplungen leben im Speicher des Dashboards; ein Neustart des Dashboards beendet sie (die Oberfläche zeigt dann „abgelaufen“).
- **Drain** (`POST /api/gateway/drain`) gilt für das Heimatverzeichnis des Dashboards, nicht für ein Profil. Bei mehreren Profilen wäre unklar, welches gemeint ist; deshalb nicht angeboten.
- **WhatsApp** braucht den QR-Code der Kopplung, installiert ggf. npm-Pakete und startet einen Node-Prozess. Das bleibt bei der Hermes-CLI (`hermes whatsapp`), bis eine QR-Darstellung ohne fremden Dienst und mit Prüfung der Abhängigkeitslizenz entschieden ist.
