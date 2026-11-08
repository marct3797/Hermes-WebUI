# Changelog

## Unveröffentlicht

### Neu
- Kanban: Reiter „Forgejo-Issues“ als eigenes Board neben dem Hermes-Board (Lesen, Anlegen, Bearbeiten, Verschieben, Kommentieren über das BFF; Token nur als Umgebungsvariable, Freigabeliste der Repos, Step-up und Audit). Übersetzungen der neuen Texte stehen noch aus (Rückfall auf Deutsch).

### Behoben
- Datums-, Zeit- und Zahlenformate sowie „vor 5 Min“ folgen der gewählten Oberflächensprache (vorher fest Deutsch, dadurch Sprachmix mit englischer Oberfläche).
- Laufstatus im Chat, Status in Werkzeuge und Hermes-Gedächtnis sowie der Eingabe-Platzhalter werden übersetzt (11 neue Schlüssel in allen 11 Katalogen).
- Tests: `install-hostd.sh` verweigert root absichtlich; die zugehörigen Tests werden unter root übersprungen, die hostd-Testsuite läuft auch als root.

### Enthalten (aus `fix/feedback-real`, vorher nie in `main`)
- Alle Änderungen seit dem Stand vom 24.10.: direkte Hermes-Bedienung, Gruppenchats, Dashboard-Brücke, Anbieter, Kanban, Marktplätze, hostd u. a. Details siehe Commit-Verlauf und `docs/coverage.md`.
