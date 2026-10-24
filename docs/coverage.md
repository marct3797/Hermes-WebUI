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
| `web_routers/ops.py` | 28 | 0 | Doctor, Backup, Import, Checkpoints, Hooks, Webhooks, Pairing, Gedächtnis zurücksetzen, Credential-Pool, Gateway start/stop |
| `web_routers/git.py` | 21 | 0 | Git im Dashboard (die WebUI nutzt dafür `hostd`) |
| `web_routers/local_models.py` | 18 | 0 | lokale Modelle: Katalog, Hardware, Download, Server |
| `web_routers/files.py` | 18 | 0 | Dateien im Dashboard (die WebUI nutzt dafür `hostd`) |
| `web_routers/messaging.py` | 11 | 0 | Messaging-Plattformen: Liste, Konfiguration, Test, Telegram-/WhatsApp-Einrichtung |
| `web_routers/audio.py` | 10 | 0 | Sprache: TTS, STT, Live-Sprachmodus |
| `web_routers/actions.py` | 8 | 0 | Gateway neu starten/leeren/migrieren, Hermes-Update |
| `web_routers/chat_ws.py` | 5 | 0 | Terminal-Chat per WebSocket (die WebUI nutzt die Gateway-API) |
| `web_routers/delegation.py` | 4 | 0 | Delegation: Routing, Backends, Modellzuordnung |
| `web_routers/memory_providers.py` | 3 | 0 | Einrichtung der Hermes-Gedächtnis-Anbieter |
| `web_routers/status.py` | 20 | 1 | Status, Gesundheit, Systemwerte, Curator, Lerngraph |
| `web_routers/tools.py` | 12 | 1 | Toolset-Konfiguration, Terminal-Backend, Computer Use |
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
| Werkzeuge (`Tools`) | teilweise: Liste. Fehlt: Toolsets ein-/ausschalten und konfigurieren, Terminal-Backend, Computer Use. **Werkzeug-Keys (Websuche usw.) lassen sich nicht setzen**, nur Anbieter-Keys | `tools.py`: 1 von 12; `providers.py` `provider_keys` |
| Skills (`Skills System`) | abgebildet. Fehlt: Curator | `skills.py`: 13 von 13 |
| Gedächtnis (`Memory`, `Memory Providers`) | **nur Hindsight** über einen eigenen Client. Fehlt: das eingebaute `MEMORY.md`/`USER.md`, Auswahl und Einrichtung der Hermes-Anbieter | `memory_providers.py`, `ops.py` |
| MCP | teilweise: Liste, Katalog, Installieren. Fehlt: Testen, Aktivieren, Entfernen, OAuth | `mcp.py`: 5 von 12 |
| Plugins | teilweise: Hub, Katalog, Installieren. Fehlt: aktivieren, deaktivieren, aktualisieren, Sichtbarkeit | `dashboard_ui.py` |
| Zeitpläne (`Cron Jobs`) | abgebildet (12 von 13 Routen); `POST /api/cron/fire` fehlt. Ob sich Skript-Jobs ohne Agent (`no_agent`) anlegen lassen, ist nicht geprüft, sie werden nur angezeigt | `cron.py`, `app/cron.py` |
| Kanban | teilweise (18 von 48): Board, Aufgaben, Kommentare, Verknüpfungen. Fehlt: Anhänge, Zerlegen/Spezifizieren/Schätzen, Läufe prüfen und beenden, Worker, Boards importieren/exportieren/wechseln, Orchestrierung | `plugins/kanban` |
| Hooks, Webhooks, Pairing | nicht abgebildet | `ops.py` |
| Delegation, Subagenten | nicht als Seite (Felder im Editor) | `delegation.py` |
| Messaging-Plattformen (35 in der Doku) | **nicht abgebildet**: weder Plattformliste noch Konfiguration noch Test | `messaging.py`: 0 von 11 |
| Gateway-Betrieb (neu starten, leeren, migrieren) | nicht abgebildet | `actions.py`, `ops.py` |
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

1. **Dashboard auf einem anderen Rechner.** Hermes 0.22.5 schaltet eine Anmeldeschranke ein, sobald das Dashboard nicht auf Loopback lauscht (`hermes_cli/dashboard_auth/__init__.py`: „engages only when the dashboard binds to a non-loopback host without --insecure“). Dann verlangt jede Anfrage eine Sitzung oder ein Bearer-Token eines registrierten Anbieters. Die WebUI schickt nur den einfachen Sitzungs-Header `X-Hermes-Session-Token`. Wahrscheinlich genügt der bei einem entfernten Dashboard nicht. **Aus dem Quelltext gelesen, nicht an einem laufenden entfernten Dashboard geprüft.** `deploy/dashboard.sh` bindet auf Loopback und ist davon nicht betroffen.
2. **Antwortformen.** Die Vertragstests stammen von Hermes 0.19 bis 0.21.6; gegen 0.22.5 sind nur die Pfade geprüft (`docs/compatibility.md`). Es gibt keine Matrix über mehrere Hermes-Versionen.
3. **Run-Strom.** Hermes sendet `run.queued`, `run.stopping` und `run.interrupted` (`gateway/platforms/api_server_runs.py`). Der Adapter gibt sie als `unknown` weiter. Nicht geprüft, wie die Oberfläche ein Stromende ohne Abschlussereignis zeigt, etwa wenn ein Lauf nach einem Gateway-Neustart „queued“ bleibt.
4. **Verwaltete Konfiguration.** Hermes kennt „Managed Scope“ (vom Administrator festgelegte, nicht änderbare Werte). Wie der Einstellungs-Editor ein abgelehntes Feld zeigt, ist nicht getestet.
5. **Oberfläche nur auf Deutsch.** `lang="de"`, alle Texte im Code, keine Übersetzungsschicht. Für ein öffentliches Projekt ist das eine Einschränkung; die englische README ersetzt sie nicht.
6. **Keine Prüfung im echten Browser** für die Seiten „Kanban“ und „Hermes-Einstellungen“ (nur jsdom).
7. **CI** prüft nur Ubuntu; `hostd` unter macOS ist beworben, nicht geprüft.

## Reihenfolge, die ich vorschlage

**P1: ohne das ist es keine vollständige Oberfläche für Hermes**
1. Messaging-Plattformen und Gateway-Betrieb (Liste, Konfiguration, Test, Start/Stopp/Neustart).
2. Werkzeuge konfigurieren und **Werkzeug-Keys setzen** (heute nur Anbieter-Keys).
3. Hermes-Gedächtnis: eingebautes `MEMORY.md`/`USER.md` und die Anbieter-Auswahl, statt nur Hindsight.
4. Profil-Lebenszyklus: anlegen, löschen, umbenennen, Import/Export.
5. Betrieb: Status/Gesundheit, Doctor, Backup, Update-Prüfung.
6. Dashboard-Anmeldeschranke für entfernte Hosts klären und gegen ein echtes Dashboard testen.
7. Vertragstests gegen 0.22.5 neu aufnehmen; Run-Strom-Ereignisse abbilden.

**P2**
8. Modelle: eigene Endpunkte, Credential-Pools, lokale Modelle, Hilfsmodelle, Mixture of Agents, Delegation.
9. MCP und Plugins verwalten; Kanban in der Tiefe; Sitzungsverwaltung (Export, Import, Aufräumen).
10. Hooks, Webhooks, Pairing; Sprache.

**P3**
11. Curator, Lerngraph, Achievements, Pets, Themes; Artefakte im Chat; Computer Use; Egress und Managed Scope anzeigen.
12. Übersetzungsschicht für die Oberfläche (Englisch zuerst).
