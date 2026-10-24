# Kompatibilität mit Hermes

Was die WebUI von einer Hermes-Installation braucht, und was davon geprüft ist. Die Aussagen unten sind in drei Stufen getrennt:
**Pfad vorhanden** (maschinell geprüft), **Form geprüft** (Vertragstests mit echten Antworten) und **offen**.

## Geprüfter Stand

| Was | Wert |
|---|---|
| Hermes-Quelltext, gegen den die Pfade geprüft sind | Hermes Agent v0.22.5 (2026.9.24), Commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e` |
| Ergebnis | 91 von 91 Hermes-Pfaden, die das BFF aufruft, kommen dort vor (Gateway 16, Dashboard 62, Kanban-Plugin 13) |
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
