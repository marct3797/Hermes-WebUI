# Vertragstests gegen echte Antwortformen

Mocks wichen mehrfach von Hermes ab (z. B. `schedule` kommt als Objekt). Deshalb liegen bereinigte, echte Antworten in
`backend/tests/fixtures/real/` und `frontend/src/fixtures/real/` (gleiche Dateien). Tests laden sie, statt Formen zu erfinden.

## Aufnehmen
1. Im Browser anmelden, das Session-Cookie aus den Entwicklerwerkzeugen kopieren.
2. `cd backend && WEBUI_COOKIE='<name>=<wert>' PYTHONPATH=. python -m devtools.capture_fixtures https://<bff> /pfad/zum/ordner`
   Das Skript macht nur lesende GETs (Liste in `PATHS`) und schreibt je eine JSON-Datei.
3. Bereinigung läuft automatisch (Key-Fragmente `«redacted:…»` zu `«redacted»`, E-Mail-Adressen, Token-artige Werte,
   Felder namens token/secret/password/api_key, Discord-IDs). **Trotzdem von Hand prüfen** (`git diff`, Suche nach `@`, `sk-`, `Bearer`),
   Org-IDs und Hostnamen bleiben sonst stehen.
4. Die Dateien in beide `real/`-Ordner kopieren und die Tests laufen lassen. Neue Felder, die Tests brechen, sind der Zweck.

Das Skript wird nicht in CI ausgeführt; getestet ist es gegen ein Mock-BFF (`backend/tests/test_fixes.py`).
