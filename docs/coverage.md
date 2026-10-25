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

Von 390 Routen (Modul, Methode, Pfad) nutzt das BFF 206 pfadgenau. Nach Modul, wenig genutzte zuerst:

| Modul | Routen | genutzt | Inhalt |
|---|---|---:|---|
| `web_routers/git.py` | 21 | 0 | Git im Dashboard (die WebUI nutzt dafür `hostd`) |
| `web_routers/files.py` | 18 | 0 | Dateien im Dashboard (die WebUI nutzt dafür `hostd`) |
| `web_routers/chat_ws.py` | 5 | 0 | Terminal-Chat per WebSocket (die WebUI nutzt die Gateway-API) |
| `dashboard_auth/routes.py` | 3 | 0 | Anmeldeschranke des Dashboards (Login-Seite, keine API für die WebUI) |
| `web_routers/chat_workspaces.py` | 1 | 0 | Chat-Arbeitsbereiche im Dashboard (die WebUI nutzt eigene Routen) |
| `web_routers/display.py` | 1 | 0 | Anzeigesteuerung im Dashboard (kein Thema einer WebUI) |
| `web_routers/local_models.py` | 18 | 1 | lokale Modelle: Status (genutzt); **bewusst nicht**: Katalog, Hardware, Download, Server, Installieren (CLI) |
| `web_routers/messaging.py` | 11 | 7 | Messaging-Plattformen: Liste, Konfiguration, Test, Telegram-Einrichtung. **Nicht**: WhatsApp-Kopplung (4 Routen, QR-Code) |
| `web_routers/audio.py` | 10 | 3 | Sprache: Live-Status, Vorlesen, Abschrift (genutzt, Aufnahmen höchstens 1,4 MB); **bewusst nicht**: `voice-config` (liefert Anbieter-Schlüssel), Live-Sitzungen, WebSockets |
| `web_routers/actions.py` | 8 | 3 | Gateway neu starten (genutzt), Aktions-Status, Update-Prüfung (genutzt); **nicht**: leeren (Drain), Hermes-Update, Migration |
| `web_routers/delegation.py` | 4 | 2 | Delegation: Routing lesen, Backend wählen (genutzt); **nicht**: Modellzuordnung und Profil-Routen schreiben |
| `web_routers/memory_providers.py` | 3 | 2 | Felder lesen/schreiben (genutzt); **bewusst nicht**: `POST .../setup` (führt `curl \| sh` aus) |
| `web_routers/status.py` | 20 | 11 | Status, Systemwerte, Curator (pausieren/starten), Lerngraph (lesen/bearbeiten/löschen, Skills werden archiviert), Computer-Use-Status; **nicht**: Host-Identität, Gesundheit, SSH-Besitz, Portal |
| `web_routers/tools.py` | 12 | 9 | Toolsets, Anbieter, Keys, Modelle; **bewusst nicht**: Terminal-Backend setzen, `post-setup`, Computer-Use-Rechte, siehe unten |
| `web_routers/models.py` | 7 | 7 | Hauptmodell, Auswahl, Hilfsmodelle, Mixture of Agents, empfohlenes Standardmodell (alle genutzt) |
| `plugins/kanban` | 48 | 27 | Kanban inkl. Diagnose, Worker, Lauf beenden, Dispatch (erst Vorschau), Schätzen, Spezifizieren, Zerlegen, Anhänge, Board-Export/Import mit Gegenlesen, Board-Archivieren/Wechseln; **nicht**: Orchestrierung schreiben, Profil-Metadaten schreiben, hartes Löschen |
| `web_routers/profiles.py` | 20 | 10 | Profile anlegen, löschen, umbenennen, exportieren, importieren |
| `web_routers/dashboard_ui.py` | 16 | 11 | Plugin-Verwaltung, Themes, Schrift (nur aus der Liste); **nicht**: eigene Theme-Dateien |
| `web_routers/sessions.py` | 18 | 15 | Statistik, Export, Aufräumen, Mehrfach-Löschen, leere löschen, Zeitachse, Import, Profil-Zuordnung (genutzt); **nicht**: Umbenennen/Fork (laufen über die Agent-API) |
| `gateway/api_server` | 46 | 20 | Läufe, Sitzungen, Jobs, eigene Teamräume (genutzt); ungenutzt u. a. OpenAI-Schnittstellen, Artefakte (Einmal-Transport für die Browser-Erweiterung), Raum-Mitglieder und Nachrichten |
| `web_routers/oauth.py` | 7 | 5 | Anmeldestatus, Anmeldung starten/abfragen (genutzt); **nicht**: Rücksprung verarbeiten, Abmelden |
| `web_routers/analytics.py` | 4 | 1 | Modellnutzung je Zeitraum (genutzt); **nicht**: übrige Auswertungen |
| `web_routers/shared_metrics.py` | 2 | 2 | Einwilligung für geteilte Metriken lesen/schreiben (genutzt) |
| `web_routers/mcp.py` | 12 | 11 | MCP testen, aktivieren, entfernen, OAuth |
| `web_routers/config_env.py` | 15 | 13 | eigene Endpunkte, Egress-Status (genutzt); **offen**: Defaults, Roh-YAML |
| `web_routers/cron.py` | 13 | 12 | Zeitpläne |
| `web_routers/skills.py` | 13 | 13 | Skills |

Pfadgenau heißt: ein Pfad zählt als genutzt, auch wenn nur eine seiner Methoden gebraucht wird.

## Funktionsbereiche

| Bereich (Hermes-Doku) | Stand in der WebUI | Beleg |
|---|---|---|
| Chat, Läufe, Freigaben, Steuern, Stoppen | abgebildet | Gateway `/v1/runs*` |
| Sitzungen | Liste, Fortsetzen, Umbenennen, Löschen, Fork, Suche, **Statistik, Export einer Sitzung, Aufräumen (mit Vorschau und Zahl eintippen), Mehrfach-Löschen (BFF), leere Sitzungen löschen, Zeitachse, Import (mit Anzahl-Bestätigung), Profil-Zuordnung (`owner-backfill`)** | `sessions.py`: 15 von 18, `routes/sessions_admin.py` |
| Profile (`Profiles`) | Lebenszyklus abgebildet: anlegen, löschen, umbenennen, Import als Upload mit Gegenlesen, Export als Hinweis, aktives Profil (`routes/lifecycle.py`, `LifecyclePage.tsx`); SOUL und Beschreibung daneben | `profiles.py`: 10 von 20 |
| Einrichtungs-Seiten | `/assistant` (5 Schritte mit Live-Prüfung, schreibt nichts; Schritt 1 bleibt `deploy/setup.py`) und `/guide` (10 Anleitungen mit Befehl und Lese-Prüfung): `SetupAssistantPage.tsx`, `guide.ts`, `GuidePage.tsx` |
| Datei-Austausch | Board-Export/Import und Profil-Import prüfen das Ergebnis (`fileexchange.py`, `docs/file-exchange.md`); Bedingung: gemeinsames Dateisystem, sonst 502 (siehe Risiken) |
| Konfiguration (`Configuration`) | abgebildet über das Schema (alle Felder, Geheimnisse ausgenommen). Fehlt: Roh-YAML, Migration, Standardwerte | `config_env.py`, `analytics.py` |
| Modelle und Anbieter (`Providers`) | eigene Seite mit Schlüssel-Pools, eigenen Endpunkten, Hilfsmodellen und Mixture of Agents (`routes/endpoints.py`, `routes/credentials.py`, `routes/models.py`, `ModelsPage.tsx`, `EndpointsPage.tsx`); lokale Modelle nur lesend (Status). **Offen**: lokale Modelle installieren/laden (bewusst CLI), Delegations-Routen schreiben | `models.py`: 7 von 7; `oauth.py`: 5 von 7; `analytics.py`: 1 von 4 |
| Werkzeuge (`Tools`) | ja: Gruppen ein-/ausschalten, Anbieter wählen (bei `web` getrennt für Suche und Extraktion), Werkzeug-Keys setzen (nur Variablen, die die Gruppe selbst nennt, nie angezeigt), Bild-/Video-Modell wählen, Terminal-Backend anzeigen. **Bewusst nicht**: Terminal-Backend umstellen, `post-setup` starten, Computer-Use-Rechte vergeben (Hermes prüft das serverseitig nicht) | `tools.py`: 9 von 12; `routes/tools.py`, `ToolsetPanel.tsx` |
| Skills (`Skills System`) | abgebildet. Fehlt: Curator | `skills.py`: 13 von 13 |
| Gedächtnis (`Memory`, `Memory Providers`) | Hindsight über einen eigenen Client **und** Hermes-Gedächtnis (`hostd/hostd/memory_files.py`, `hostd/hostd/operations.py`, `backend/app/routes/hermes_memory.py`, `HermesMemoryPage.tsx`): Inhalt von `MEMORY.md`/`USER.md` lesen und bearbeiten, SHA-256-Prüfung, 5 Sicherungen, Schreiben nur mit frischer Anmeldung. Anbieter wählen und einrichten mit echten Feld-Arten (`text/select/secret/bool/number/json`), Gruppen, Info-Texten, Options-Beschreibungen und Anbieter-Docs-Link. **Nicht**: Anbieter-Programme installieren | `routes/hermes_memory.py`, `HermesMemoryPage.tsx`; `ops.py` Gedächtnis-Routen: 3 von 3 |
| MCP | Liste, Katalog, Installieren, Testen, Aktivieren, Entfernen, OAuth. **Nicht**: ganze `mcp_servers`-Map ersetzen (`PUT /api/mcp/servers`) | `mcp.py`, `routes/extensions.py` |
| Plugins | Hub, Katalog, Installieren, Aktivieren, Deaktivieren, Aktualisieren, Entfernen. **Nicht**: Sichtbarkeit in der Seitenleiste, Speicher-/Kontext-Anbieter über `plugin-providers` (stehen im Einstellungs-Editor) | `dashboard_ui.py`, `routes/extensions.py` |
| Zeitpläne (`Cron Jobs`) | abgebildet (12 von 13 Routen); `POST /api/cron/fire` ist der NAS-Webhook (kein manueller Auslöser, bewusst nicht verdrahtet), manuell auslösen geht über `trigger`. Skript-Jobs ohne Agent (`no_agent`) lassen sich mit eingetippter Bestätigung anlegen | `cron.py`, `app/cron.py` |
| Kanban | teilweise (27 von 48): Board, Aufgaben, Kommentare, Verknüpfungen, Anhänge, Zerlegen/Spezifizieren/Schätzen, Läufe prüfen und beenden, Worker, Boards importieren/exportieren/archivieren/wechseln. Fehlt: Orchestrierung schreiben, Profil-Metadaten, hartes Löschen | `plugins/kanban` |
| Hooks, Webhooks, Pairing | **Pairing** (offene Anfragen freigeben nur per Anfrage-ID, Zugang sperren mit eingetippter ID) und **Webhooks** (anlegen ohne `script` und ohne eigenes Secret, Secret nur einmal sichtbar, ein-/ausschalten, löschen mit Namenseingabe, Plattform einschalten nur mit Neustart-Bestätigung). **Nicht**: Hooks (führen Shell-Befehle aus), Freigabe per Code, `clear-pending` | `routes/access.py` |
| Delegation, Subagenten | Backend wählen (nur aus der gemeldeten Liste), Routen lesen (Schlüssel nie). **Nicht**: `model_map`/`profile_routes` schreiben (tragen Schlüssel je Route) | `delegation.py`: 2 von 4, `routes/endpoints.py` |
| Messaging-Plattformen | **ja**: Liste mit Zustand, Variablen setzen/löschen (Tokens nie sichtbar), ein-/ausschalten, Verbindung prüfen, Telegram-Assistent. **Nicht**: WhatsApp koppeln (QR-Code), Heimatkanal setzen, Plattform-Plugins verwalten | `routes/messaging.py`, `MessagingPage.tsx`; `messaging.py`: 7 von 11 |
| Gateway-Betrieb | teilweise: Zustand, starten, anhalten, neu starten (Unterbrechen nur nach Bestätigung), Protokoll des Befehls. **Nicht**: leeren (Drain), migrieren | `actions.py`: 3 von 8, `ops.py` |
| Sprache (`Voice Mode`, `Text-to-Speech`) | eigene Seite (`VoicePage.tsx`, `routes/voice.py`): Live-Status, Vorlesen, Abschrift (Aufnahmen höchstens 1,4 MB). **Bewusst nicht**: `voice-config` (liefert Anbieter-Schlüssel), Live-Sitzungen, WebSockets | `audio.py`: 3 von 10 |
| Browser, Vision, Bildgenerierung | Bild-Anhänge im Chat (bis zu 4 je Nachricht); der Rest nur über Einstellungsfelder | `routes/agents.py`, Schema |
| Artefakte im Chat (`Deliverable Mode`) | bewusst nicht abgebildet: Hermes lädt Dateipfade aus dem Antworttext nur für Messaging-Plattformen hoch (Gateway erkennt sie und hängt sie an, siehe `website/docs/user-guide/features/deliverable-mode.md` im Hermes-Quelltext). `/v1/artifacts/*` ist nur ein Einmal-Transport für die Browser-Erweiterung (Upload/Download, 10 MiB, 300 s, `gateway/browser_control_artifacts.py:24-30`) | Gateway `/v1/artifacts/*` |
| Betrieb: Doctor, Backup/Import, Checkpoints, Update, Sicherheitsprüfung | eigene Seite (`LifecyclePage.tsx`, `routes/lifecycle.py`): Status, Gesundheit, Update-Prüfung, Doctor und Backup mit Schranken, dazu Diagnose je Agent. **Bewusst nicht**: Update ausführen, Migration, Import, Checkpoints, Hooks | `ops.py`, `actions.py` |
| Status, Gesundheit, Systemwerte, Curator, Lerngraph | eigene Seiten (`InsightsPage.tsx` mit Systemwerten, Datenschutz und Computer-Use-Status; `LearningPage.tsx` für den Lerngraphen mit Lesen/Bearbeiten/Löschen; Curator mit Pausieren/Starten und Protokoll; `routes/insights.py`). **Nicht**: Host-Identität, Gesundheit, SSH-Besitz, Portal | `status.py`: 11 von 20; `shared_metrics.py`: 2 von 2 |
| Räume und Bots | **eigenes Konzept der WebUI** (`rooms.db`), nicht die Raum-Funktion von Hermes (`/v1/room-members/*`) | `routes/rooms.py` |
| Themes, Schriften, Sprachpakete von Hermes | Hermes-Themes und Schrift wählen (`InsightsPage.tsx`, `routes/insights.py`); **nicht**: eigene Theme-Dateien ablegen. Die WebUI hat eigene Themes (`ui.json`); Sprachpakete von Hermes nutzt sie nicht, die Oberfläche hat zwölf Sprachen | `dashboard_ui.py`: 11 von 16 |
| Achievements, Pets | eigene Seite (`AchievementsPage.tsx`, `routes/achievements.py`): Liste, erneutes Prüfen, Zurücksetzen mit Schranke. Pets zeigt Hermes nicht als eigene Daten; was das Plugin liefert, steht in der Liste | `plugins/hermes-achievements`: 3 von 6 |
| OpenAI-kompatible Schnittstellen (`/v1/chat/completions`, `/v1/responses`) | bewusst nicht genutzt (die WebUI nutzt die Läufe-Schnittstelle) | Gateway |
| ACP, Hermes als Python-Bibliothek, Editor-Anbindung | kein Thema einer Weboberfläche | |

## Risiken für den Betrieb mit beliebigen Installationen

1. **Dashboard auf einem anderen Rechner.** Geprüft an einem echten Dashboard (0.22.5, Loopback): Hermes vergleicht den Rechnernamen im `Host`-Header (Port egal): `127.0.0.1`, `localhost` gehen, jeder andere Name liefert 400 „Invalid Host header“. Bindet das Dashboard nicht auf Loopback, schaltet Hermes eine Anmeldeschranke ein (Sitzung oder Bearer-Token eines Anbieters; `--insecure` ist wirkungslos, siehe `hermes dashboard --help`). Der Sitzungs-Header der WebUI genügt dann nicht. **Der unterstützte Weg ist Loopback plus Tunnel:** Dashboard auf `127.0.0.1` des Hosts lassen, per `ssh -N -L 127.0.0.1:19119:127.0.0.1:9119 <benutzer>@<host>` auf den WebUI-Rechner führen und `http://127.0.0.1:19119` eintragen (`add-host.sh --dashboard-url`). Die WebUI meldet die drei Fälle (falscher Rechnername, eigene Anmeldung verlangt, Token abgelehnt) jetzt mit diesem Ausweg. Nicht getestet: die Antwort der Schranke selbst an einer nicht-loopback gebundenen Instanz (aus dem Quelltext gelesen: 401 oder Weiterleitung auf `/login`; beides ist abgefangen).
2. **Antwortformen.** Die Lese-Routen sind gegen echte Antworten von 0.22.5 getestet (`tests/test_contract_hermes_0_22_5.py`, Fixture aus einem Sandbox-Dashboard). Nicht aufgenommen sind Schreib-Routen und Zustände mit Daten (laufende Sitzungen, eingerichtete Anbieter, Zeitpläne): das frische Sandbox-HOME hat keine. Pfade über mehrere Hermes-Versionen prüft `docs/compatibility.md` (44 Stände von `v2026.3.12` bis `v0.22.5`); Antwortformen anderer Versionen sind **nicht** geprüft.
3. **CI** läuft auf Ubuntu und macOS (`.github/workflows/ci.yml`: Backend auf beiden, `hostd` und `fresh-install` nur auf Ubuntu); nur die `hostd`-Tests mit echten CLIs werden übersprungen, sofern die CLIs fehlen. Die systemd-Installation (`deploy/install-hostd.sh`) läuft nicht in CI.
4. **Run-Strom.** Korrektur: `run.stopping` und `run.interrupted` sind Lauf-*Status* (`GET /v1/runs/{id}`), keine Stromereignisse; `runStore.ts` behandelt sie beim Nachfragen (Zeilen 154 bis 172). Nur `run.queued` kommt als Ereignis (als `unknown`), danach setzt die Wiederaufnahme per Statusabfrage fort. Aus dem Quelltext gelesen, nicht mit einem laufenden Gateway-Neustart geprüft.
5. **Verwaltete Konfiguration.** Hermes kennt „Managed Scope“ (vom Administrator festgelegte, nicht änderbare Werte). Wie der Einstellungs-Editor ein abgelehntes Feld zeigt, ist nicht getestet.
6. **Übersetzungen maschinell.** Die Oberfläche hat zwölf Sprachen (de, en, es, fr, pt, zh, zh-hant, ja, ko, ar, it, tr; `frontend/src/i18n.ts`, `frontend/src/locales/`, 2293 Schlüssel je Sprache laut `frontend/src/locales/_keys.json`); die Texte stammen aus einer maschinellen Übersetzung und sind nicht von Muttersprachlern geprüft. Arabisch läuft rechts-nach-links (`rtl` in `i18n.ts`); Russisch gibt es nicht. Fachbegriffe können daher abweichen.
7. **Datei-Austausch braucht dasselbe Dateisystem.** Board-Export/Import und Profil-Import reichen dem Dashboard nur einen Pfad (`routes/kanban_admin.py`, `routes/lifecycle.py`, Prüfung in `fileexchange.py`, `docs/file-exchange.md`). Sehen BFF und Dashboard nicht dasselbe Dateisystem, meldet das BFF 502 statt eines falschen Erfolgs; Erfolg prüft es per Gegenlesen nach.
8. **Keine Prüfung im echten Browser** für die Seiten „Kanban“ und „Hermes-Einstellungen“ (nur jsdom).

## Reihenfolge, die ich vorschlage

**P1: ohne das ist es keine vollständige Oberfläche für Hermes**
1. ~~Messaging-Plattformen und Gateway-Betrieb~~ umgesetzt und gegen ein echtes Dashboard geprüft (`devtools/real/contract_messaging.py`). Offen daraus: WhatsApp-Kopplung (QR), Drain.
2. ~~Werkzeuge konfigurieren und Werkzeug-Keys setzen~~ umgesetzt und gegen ein echtes Dashboard geprüft (`devtools/real/contract_tools.py`).
3. ~~Hermes-Gedächtnis~~ umgesetzt und gegen ein echtes Dashboard geprüft (`devtools/real/contract_memory.py`). Stand danach: Inhalt von `MEMORY.md`/`USER.md` wird über hostd gelesen und bearbeitet (`hostd/hostd/memory_files.py`, `hostd/hostd/operations.py`, `routes/hermes_memory.py`, `HermesMemoryPage.tsx`); das Dashboard liefert weiter nur die Größe.
4. ~~Profil-Lebenszyklus: anlegen, löschen, umbenennen, Import/Export~~ umgesetzt und gegen ein echtes Dashboard geprüft (`devtools/real/contract_lifecycle.py`): Canvas-Regel wie Hermes (klein, kein reservierter Name), Löschen/Backup nur mit Namenseingabe, Import nur per Upload (BFF schreibt in eine temp-Datei und meldet den Pfad; freie Pfade 422), Export nur als Hinweis auf den Agenten-Rechner, Setup-Befehl nur als Text für das Dashboard-Heim.
5. ~~Betrieb: Status/Gesundheit, Doctor, Backup, Update-Prüfung~~ umgesetzt (nur Lesen + Doctor/Backup mit Schranken; Update bleibt bewusst draußen).
6. ~~Dashboard-Anmeldeschranke für entfernte Hosts~~ geklärt und gegen ein echtes Dashboard geprüft (Punkt 1 oben): Tunnel statt Adresse.
7. ~~Vertragstests gegen 0.22.5~~ für die Lese-Routen aufgenommen; Run-Strom war falsch eingeschätzt (Punkt 3 oben).

**P2**
8. ~~Modelle~~ umgesetzt: Hauptmodell, Auswahl, Hilfsmodelle, MoA (`routes/models.py`); eigene Endpunkte mit URL-Schranken, Schlüssel write-only, Löschen mit eingetippter ID (`routes/endpoints.py`); Delegations-Backend; Schlüssel-Pools (`routes/credentials.py`); lokale Modelle nur lesend. **Offen**: lokale Modelle installieren/laden (bewusst CLI), Delegations-Routen schreiben.
9. ~~MCP und Plugins verwalten~~ (schon vorher im BFF), ~~Sitzungsverwaltung~~ umgesetzt (Zeitachse, Import mit Anzahl-Bestätigung, Profil-Zuordnung). **Offen**: Kanban in der Tiefe (27 von 48 Routen).
10. ~~Hooks, Webhooks, Pairing~~ umgesetzt, Hooks bewusst aus. ~~Sprache~~ umgesetzt (`routes/voice.py`, `VoicePage.tsx`; `audio.py`: 3 von 10).

**P3**
11. ~~Curator, Lerngraph, Themes, Achievements~~ umgesetzt (`routes/insights.py` mit `InsightsPage.tsx` und `LearningPage.tsx`; `routes/achievements.py` mit `AchievementsPage.tsx`; `status.py`: 11 von 20; `dashboard_ui.py`: 11 von 16; Plugin: 3 von 6). **Offen**: Pets als eigene Daten (das Plugin liefert keine), Artefakte im Chat, Computer Use, Egress und Managed Scope anzeigen.
12. ~~Übersetzungsschicht für die Oberfläche~~ umgesetzt (zwölf Sprachen, `frontend/src/locales/`, 2174 Schlüssel je Sprache; Texte maschinell übersetzt, nicht muttersprachlich geprüft).

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

## Hermes-Gedächtnis: bewusste Grenzen

- Das Dashboard liefert von `MEMORY.md`/`USER.md` nur die Größe in Bytes. Es gibt dort keine Route zum Lesen oder Schreiben (im Quelltext gesucht). Die WebUI liest und schreibt den Inhalt deshalb über hostd (`hostd/hostd/memory_files.py`, `routes/hermes_memory.py`, Seite `HermesMemoryPage.tsx`): SHA-256-Prüfung, 5 Sicherungen, Schreiben nur mit frischer Anmeldung.
- Zurücksetzen löscht ohne Papierkorb und ohne Sicherung. Die WebUI verlangt, den Zielnamen einzutippen, und liest danach die Größen zurück. Daten externer Anbieter bleiben unberührt (so Hermes).
- Der Anbieter-Setup von Hermes führt Befehle der Anbieter-Manifeste mit Shell aus (z. B. `curl -fsSL https://byterover.dev/install.sh | sh`), mit der Umgebung des Dashboards. Das reicht die WebUI nicht durch; sie nennt nur, welches Programm fehlt und wie man es auf dem Rechner selbst installiert.
- Hermes setzt beim Speichern der Anbieter-Felder den Anbieter aktiv, sobald er bereit ist. Ist er nicht bereit, sind die Werte trotzdem gespeichert, und die WebUI zeigt die Fehlermeldung von Hermes.

## P2 gegen ein echtes Dashboard geprüft (`devtools/real/contract_p2_bff.py`, Sandbox-HOME, 31 von 31)

Das echte BFF gegen das echte Hermes-Dashboard 0.22.5. Befunde, die der Mock nicht gezeigt hat:

- **Frische Installation**: `model/info`, `options`, `recommended-default` liefern gültige, aber leere Antworten (kein Anbieter, kein Modell). Das BFF meldet das als Daten (`configured: false`, `available: false`), die Seite erklärt „Noch kein Anbieter eingerichtet“. Falsch geformte Antworten bleiben 502.
- **`POST /api/model/set`** lehnt Anbieter ohne Schlüssel/Anmeldung selbst ab („is not connected“); das BFF reicht den Text durch und schreibt nichts. Erfolgspfad live über einen eigenen Endpunkt als verbundenen Anbieter belegt, Rücklesen bestätigt.
- **Eigene Endpunkte**: Schlüssel erscheint nie in einer Antwort (nur `has_api_key`), Metadaten-URL wird vor Hermes abgewiesen, Löschen nur mit eingetippter ID.
- **Sitzungen**: ein Dashboard ohne gestartetes Gateway antwortet 503 „Session store is not initialized“. Das BFF reicht den Text durch, die Seite zeigt ihn.

**Nicht live belegt** (nur Mock + Quelltext): Erfolgspfade von Aufräumen, Mehrfach-Löschen, Leere löschen und Export (der Sitzungsspeicher der Sandbox ließ sich ohne laufendes Gateway nicht befüllen; `sessions/import` verlangt Client-Versionsabgleich), Webhook anlegen/umschalten/löschen und Pairing freigeben/sperren (brauchen eingeschaltete Webhook-Plattform bzw. eine echte Anfrage; Einschalten startet das Gateway neu).

## P2-Reste und P3 gegen ein echtes Dashboard geprüft (`devtools/real/contract_p3_bff.py`, Sandbox-HOME, 33 von 33)

Schlüssel-Pools, Sprache, System, Curator, Lerngraph, Darstellung, Datenschutz, Achievements und Kanban-Diagnose, jeweils über das echte BFF gegen das echte Dashboard 0.22.5. Befunde, die der Mock nicht gezeigt hat:

- **Sprache**: `voice-live/status` meldet `available: false` (kein OpenAI-Schlüssel), obwohl Vorlesen trotzdem Audio liefert. Die Seite nennt den Status deshalb „Live-Sprache“ und sperrt Vorlesen und Abschrift nicht. Das Vorlesen ging in der Sandbox an einen externen Sprachdienst; Anbieter und Kosten stehen in der Hermes-Konfiguration.
- **Datenschutz**: der Egress-Status ist mehrzeiliger Text („Egress proxy status … Enabled: no …“), die Seite zeigt ihn mit Zeilenumbrüchen.
- **Schlüssel-Pools**: der Schlüssel kommt nie zurück, nur die letzten vier Zeichen; Entfernen nur für `manual`-Einträge und nur mit eingetipptem Anbieternamen.
- **Achievements**: 60 Erfolge in der Sandbox, geheime erscheinen als „???“.

**Nicht live belegt** (nur Mock + Quelltext): Curator-Lauf (verbraucht Tokens), Achievements zurücksetzen und neu scannen, Metrik-Senden (schickt Daten weg), Dispatch mit Start, Lauf beenden, Schätzen und Spezifizieren (brauchen ein Hilfsmodell).

## P3: bewusst nicht gebaut

- **Artefakte** (`POST /v1/artifacts/upload`, `GET /v1/artifacts/download/{id}` der Gateway-API): bewusst nicht. Im Quelltext (`gateway/platforms/api_server.py`, `_artifact_route_prelude`) gibt es sie nur bei `browser.extension_control.enabled`; sie sind der Transportweg der Hermes-Browsererweiterung (Zugriff über einen aus dem API-Schlüssel abgeleiteten Principal, Download einmalig, nur Typen aus einer Erlaubnisliste). Es ist kein Datei-Feature für Nutzer.
- **Computer Use**: nur der Status (`GET /api/tools/computer-use/status`) wird angezeigt. Die Rechte-Vergabe (`POST .../permissions/grant`, nur macOS) bleibt aus; Serverpfade (`source`, `detail`) gehen nicht an den Browser.
- **Pets**: im Quelltext nur als CLI-Unterbefehl (`hermes pets`) gefunden, keine Dashboard- oder Gateway-Route; die WebUI bildet es nicht ab.
- **Eigene Theme-Dateien**: nicht geprüft, ob Hermes dafür eine Route anbietet.
- **`host/identity`, `health/*`, `ssh/ownership`, `portal`, `ops/dump`, `ops/debug-share`, `ops/config-migrate`**: Anbindung des Desktop-Clients bzw. Upload von Diagnosedaten an einen Fremddienst.
- **Sprache**: `voice-config`, Live-Sitzungen und WebSockets (Dauerverbindungen, Schlüsselauslieferung).
- **Lerngraph**: als Liste mit Verbindungsanzahl, nicht als gezeichneter Graph.

## Lerngraph gegen ein echtes Dashboard (`devtools/real/contract_learning_bff.py`, Sandbox-HOME, 17 von 17)

Der Graph einer frischen Installation ist leer: Knoten sind nur Skills mit Lernsignal (vom Agenten angelegt oder benutzt) und Einträge des Gedächtnisses. Das Skript legt in der Sandbox einen Skill und zwei Einträge an, bearbeitet und löscht sie über das BFF und räumt alles wieder auf. Befunde, die der Mock nicht gezeigt hat:

- **Die ID eines Gedächtnis-Eintrags trägt einen Fingerabdruck seines Textes** (`memory:memory:0:8001e0be9bd2`). Nach dem Bearbeiten gilt eine neue ID; das Rücklesen mit der alten ID lieferte 404, obwohl gespeichert war. Das BFF findet den Eintrag jetzt über Quelle und Nummer wieder, meldet die neue ID, und die Seite folgt ihr.
- **Löschen eines Skills heißt in Hermes Archivieren** (Ordner `skills/.archive/<name>`, mit der Hermes-CLI zurückholbar). Die Seite sagt das und beschriftet den Knopf entsprechend; Erinnerungen werden wirklich gelöscht.
- Ein Skill mit ungültigem Frontmatter wird von Hermes abgelehnt (400); das BFF reicht den Text durch und schreibt nichts.
