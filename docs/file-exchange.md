# Datei-Austausch zwischen WebUI und Hermes

Board- und Profil-Export/Import reichen dem Hermes-Dashboard nur einen Dateipfad. Das gelingt nur, wenn WebUI (BFF) und Dashboard dasselbe Dateisystem sehen: ein Rechner, oder ein gemeinsamer Datenordner, der auf beiden Seiten unter demselben Pfad liegt.

## Wann es geht

- WebUI und Dashboard laufen auf demselben Rechner: Export und Import funktionieren.
- Beide sehen denselben Datenordner unter demselben Pfad: funktioniert ebenfalls.
- Verschiedene Rechner oder Container ohne gemeinsamen Ordner: Export und Import scheitern mit 502.

## Was die Meldung bedeutet

"Die Datei liegt nicht im Dateisystem der WebUI. Export und Import gehen nur, wenn WebUI und Hermes denselben Datenordner sehen. Ausweg: den Befehl auf dem Hermes-Rechner ausführen (siehe docs/file-exchange.md)."

Das BFF meldet das, wenn die Archivdatei fehlt, leer ist, kein gzip/zip ist, zu groß ist, oder wenn das Dashboard "file not found" (bzw. 404/422) antwortet. Bei Erfolg prüft das BFF nach: Export liest das Archiv zurück, Import liest die Profil- bzw. Boardliste gegen. Findet das Gegenlesen nichts, meldet das BFF 502 statt eines falschen Erfolgs. Temp-Dateien des Imports räumt das BFF immer auf, auch bei Fehlern.

Der Profil-Export liefert bewusst nur einen Hinweis mit Pfad auf dem Rechner des Agents, nie das Archiv selbst.

## Ausweg über die CLI (auf dem Hermes-Rechner)

- Board: `hermes kanban boards export [<slug>] [-o archiv]` und `hermes kanban boards import <archiv> [--as slug]` (hermes_cli/kanban_parser.py, Zeilen 125-146).
- Profil: `hermes profile export <profilname> [-o datei]` und `hermes profile import <archiv> [--name name]` (hermes_cli/subcommands/profile.py, Zeilen 115-126).
