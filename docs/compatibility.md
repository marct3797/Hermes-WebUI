# Kompatibilität mit Hermes

Was die WebUI von einer Hermes-Installation braucht, und was davon geprüft ist. Die Aussagen unten sind in drei Stufen getrennt:
**Pfad vorhanden** (maschinell geprüft), **Form geprüft** (Vertragstests mit echten Antworten) und **offen**.

## Geprüfter Stand

| Was | Wert |
|---|---|
| Hermes-Quelltext, gegen den die Pfade geprüft sind | Hermes Agent v0.22.5 (2026.9.24), Commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e` |
| Ergebnis | 95 von 95 Hermes-Pfaden, die das BFF aufruft, kommen dort vor (Gateway 16, Dashboard 66, Kanban-Plugin 13) |
| Antwortformen (Vertragstests) | Lese-Routen des Dashboards gegen echte Antworten von 0.22.5 (`tests/fixtures/real/hermes_0_22_5_dashboard.json`, `tests/test_contract_hermes_0_22_5.py`); der Rest aufgenommen gegen Hermes 0.19 bis 0.21.6 (siehe `docs/contract-tests.md`). Gateway-API und Schreib-Routen **nicht neu aufgenommen** |

Nachprüfen, ohne uns zu glauben:

```
cd backend
python -m devtools.check_upstream /pfad/zu/hermes-agent     # Exit 0 = alle Pfade vorhanden
```

Das Skript liest Zeichenketten aus dem Quelltext. Es beweist, dass ein Pfad existiert, nicht dass Anfrage und Antwort passen.
`backend/tests/test_compat.py` stellt sicher, dass kein vom BFF genutzter Pfad in der Liste fehlt.

Welche Hermes-Funktionen die WebUI abbildet und welche nicht (390 Routen, Funktionsbereiche, Risiken, Reihenfolge): [coverage.md](coverage.md).

## Bausteine

| Baustein | Aufgabe | Pflicht? | Wo er herkommt |
|---|---|---|---|
| Gateway-API (`API_SERVER_KEY`) | Chat, Läufe, Sitzungen, Skills- und Werkzeugliste, Zeitpläne der API | ja, je Agent | Hermes: `gateway/platforms/api_server.py` |
| Dashboard (`hermes dashboard`) | Profil, SOUL, Modell, Einstellungen, Keys, Skills, MCP, Plugins, Zeitpläne, Logs | nein; ohne es sind diese Seiten „nicht eingerichtet“ | Hermes: `hermes_cli/web_routers/` |
| Kanban-Plugin | Kanban-Board | nein | Hermes liegt es bei: `plugins/kanban` |
| Host-Dienst `hostd` | Terminal, Dateien, Git, Suche, CLI-Anmeldung, Verwaltung | nein | dieses Repo: `hostd/` |
| Kontingent-Plugin `ai-usage-tracker` | Kontingentanzeige | nein | dieses Repo: `deploy/install-quota-plugin.sh` (**nicht Teil von Hermes**) |
| Gedächtnis-Anbieter | Gedächtnis-Seite | nein | Hindsight (siehe unten) |
| Wissensquelle | Seite Wissen | nein | `hermes-rag` mit Chroma |

## Funktionen

| Funktion | Braucht | Stand |
|---|---|---|
| Chat, Freigaben, Steuern, Stoppen, Sitzungen, Fork | Gateway | Pfad vorhanden |
| SOUL, Beschreibung, Standardmodell | Dashboard | Pfad vorhanden |
| **Hermes-Einstellungen** (alle Felder des Dashboard-Schemas) | Dashboard | Pfad vorhanden. Schema und Werte kommen vom Dashboard; Geheimnisfelder sind gesperrt (siehe unten) |
| Keys, Anmeldung bei Anbietern, Nutzung | Dashboard | Pfad vorhanden |
| Anbieter- und Modelllisten | Dashboard | Pfad vorhanden; ausgeblendete Anbieter per `HERMES_WEBUI_HIDDEN_PROVIDERS` |
| Skills, Werkzeuge, MCP, Plugins, Marktplatz | Dashboard | Pfad vorhanden |
| Zeitpläne, Logs | Dashboard | Pfad vorhanden |
| Kanban | Kanban-Plugin | Pfad vorhanden |
| Kontingente | Kontingent-Plugin | nur mit installiertem Plugin; ohne es „nicht eingerichtet“ |
| Terminal, Dateien, Git, Suche, CLI-Anmeldung | hostd | Die hostd-Tests laufen in CI auf Ubuntu. **Nicht in CI:** die systemd-Installation (`deploy/install-hostd.sh`), macOS (in `hostd/README.md` genannt) und die zwei Integrationstests mit echten CLIs (übersprungen, sofern die CLIs fehlen) |
| Gedächtnis | Anbieter vom Typ `hindsight` | **nur Hindsight.** Andere Gedächtnis-Plugins von Hermes sind nicht angebunden (offen) |
| Wissen | `hermes-rag` | nur dieser Typ |
| Räume (Gruppenchats) | Gateway je Teilnehmer | Pfad vorhanden |
| Geführter Einrichtungs-Assistent | | Terminal-Skript `deploy/setup.py` (Gateway, Dashboard, Anmeldung, Step-up, ausgeblendete Anbieter, Verbindungsprüfung). Kein Browser-Assistent, mit Absicht |

## Hermes-Einstellungen: was die Seite zusichert und was nicht

- Felder, Typen, Beschreibungen und Bereiche kommen aus `GET /api/config/schema`, die Werte aus `GET /api/config`. Neue Felder in einer
  neueren Hermes-Version erscheinen ohne Änderung an der WebUI.
- Geschrieben wird nur, was sich geändert hat, per `PUT /api/config`. Danach liest die WebUI zurück und meldet, was das Dashboard
  nicht übernommen hat.
- **Geheimnisse:** Textfelder, deren letztes Namensglied `api_key`, `token`, `secret`, `password` (auch `_hash`), `credential`,
  `private_key` oder `auth_key` ist, werden nie ausgeliefert und lassen sich hier nicht schreiben. Gegen das Schema von 0.22.5 sind das
  23 von 908 Feldern. Die Erkennung geht nach dem Namen; ein Geheimnis in einem anders benannten Feld erkennt sie nicht.
- **Wirkung:** Hermes meldet nicht, ob eine Einstellung sofort, für neue Sitzungen oder erst nach einem Neustart gilt. Die Seite sagt das
  und behauptet nichts anderes.
- Listen werden als JSON bearbeitet. Schlüssel, die im Schema fehlen (z. B. `custom_providers`), bleiben unberührt.

## Mehrere Hermes-Versionen (gemessen mit `devtools/compat_matrix.py`)

```
cd backend
python -m devtools.compat_matrix /pfad/zu/hermes-agent v2026.8.13 v2026.9.24 v0.21.6 v0.22.5   # Tags aufsteigend
```

Das Werkzeug holt den Quelltext jedes Tags mit `git archive` (nur lesend) und prüft, ob jeder von der WebUI genutzte Pfad dort vorkommt. Gemessen wurden 44 Stände von `v2026.3.12` bis `v0.22.5`.

| Hermes-Stand | fehlende Pfade (von den genutzten) |
|---|---:|
| v2026.4.30 (Hermes 0.12.0) | 124 |
| v2026.6.19 (0.17.0) | 26 |
| v2026.7.20 (0.19.0) | 13 |
| v2026.8.13 (0.20.1) | 8 |
| v2026.9.7 (0.21.1) | 6 |
| v2026.9.24 (0.21.5) | 4 |
| v0.21.6, v0.21.7, v0.22.0 | 3 |
| v0.22.1, v0.22.3, v0.22.4 | 2 |
| v0.22.2 | 3 |
| v0.22.5 | 0 |

**Ab welcher Version gibt es welche Funktion** (erste Version, in der der Pfad vorkommt):

| Funktion | Pfad | ab |
|---|---|---|
| Delegation (Seite „Eigene Endpunkte“) | `/api/delegation/routing`, `/api/delegation/backend` | v0.22.5 |
| Rückfragen des Agenten beantworten | Gateway `/v1/runs/{}/clarify` | v0.22.3 |
| Einwilligung für Metriken | `/api/shared-metrics/consent` | v0.21.6 |
| Sprache: Live-Status | `/api/audio/voice-live/status` | v2026.9.14 |
| Plugin-Katalog | `/api/dashboard/plugins/catalog` | v2026.9.11 |
| Lokale Modelle, Skills-Hub (offiziell) | `/api/local-models/status`, `/api/skills/hub/official` | v2026.9.7 |
| Profil-Import, Steuern eines Laufs | `/api/profiles/import`, Gateway `/v1/runs/{}/steer` | v2026.8.13 |

Vor `v2026.8.13` fehlen weitere Gruppen (u. a. Gesundheit, Egress, Aufwandsschätzung im Kanban, Lerngraph, eigene Endpunkte, Mixture of Agents); dort ist die WebUI nicht sinnvoll nutzbar.

**Verhalten bei einer älteren Version.** Kennt das Dashboard eine Route nicht (Hermes antwortet `404 No such API endpoint: …`, in allen geprüften Ständen ab `v2026.7.20` vorhanden), meldet das BFF `501` mit „Diese Hermes-Version kennt <Pfad> nicht. Hermes aktualisieren“, statt „404“ oder „502“. Fehlende Ressourcen (`skill 'x' not found`) bleiben `404` mit ihrem eigenen Text. Plugin-Routen (`/api/plugins/…`) behalten ihre Meldung „Plugin nicht installiert“.

**Was das nicht belegt.** Es prüft nur, ob der Pfad existiert. Ob die Antworten dieselbe Form haben, belegen nur die Vertragstests, und die laufen ausschließlich gegen Hermes 0.22.5 (`tests/fixtures/real/hermes_0_22_5_dashboard.json`). Für andere Versionen sind Formen **nicht** geprüft; das BFF prüft Formen selbst und meldet 502 bei Abweichung, statt zu raten. Die Gateway-Route für Rückfragen (aiohttp) hat keinen „No such API endpoint“-Text und wird bei älteren Ständen nicht gesondert erklärt.

**Offene Entscheidung: Mindestversion.** Vorschlag: Hermes **0.21.6** (die älteste stabile Version der Messung mit nur drei fehlenden Pfaden). Dort fehlen nur Delegation (ab 0.22.5) und Rückfragen (ab 0.22.3); beides endet in einer verständlichen Meldung. Darunter wächst die Zahl der Lücken, ohne dass die WebUI sie bisher je gegen eine echte Installation dieser Version gesehen hat.
