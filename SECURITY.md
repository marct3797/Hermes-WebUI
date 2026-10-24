# Bedrohungsmodell (STRIDE, eine Seite)

Stand: Phase 0. Die WebUI ist ein Einzelnutzer-Werkzeug: Eine Person steuert über den Browser Agents, die auf
eigenen Rechnern Befehle ausführen können. Das ist der Wert, den es zu schützen gilt: **Wer die WebUI
kontrolliert, kontrolliert die Agents.** Deshalb gilt: fällt eine Schicht (Tailnet-Zugang, Browser-Sitzung,
Agent-Ausgabe), bleibt der Schaden begrenzt.

## Vertrauensgrenzen

```
Browser ──HTTPS── Caddy (TLS) ── BFF (FastAPI) ──┬── Hermes-API-Server je Host (Key, nur Loopback)
  (nicht vertraut)  (vertraut)     (vertraut)    ├── Forgejo (nur OIDC-Login)
                                                 └── später: Host-Dienst auf dem Laptop (ausgehende WSS)
```

- Der Browser ist nicht vertrauenswürdig. Er bekommt nie Keys, Tokens des Anbieters oder Pfade außerhalb der API.
- Alles, was ein Agent ausgibt (Text, Befehle, Tool-Vorschauen), ist **fremder Inhalt**, auch wenn es von der eigenen Instanz kommt.
- Zugangsdaten stehen in Umgebungsvariablen oder in Dateien mit Modus 0600, nie im Repo, im Chat oder im Frontend.

## Bedrohungen und Maßnahmen

| | Bedrohung | Maßnahme | Stand |
|---|---|---|---|
| **S**poofing | Fremder Zugriff auf die UI | Forgejo-Login (Authorization Code mit PKCE S256, `state`, `nonce`), ID-Token-Prüfung (Signatur über JWKS, `iss`, `aud`, `exp`, `nonce`), nur asymmetrische Verfahren (kein HS256), Allowlist auf feste `sub`-IDs. 2FA wird in Forgejo erzwungen (nicht Teil dieses Codes). | umgesetzt |
| | Login-CSRF, fremder Browser schließt einen Anmeldeversuch ab | `state` einmalig und serverseitig gespeichert, Anmeldeversuch zusätzlich an ein `__Host-`-Cookie des Browsers gebunden | umgesetzt |
| | Manipulierte OIDC-Discovery lenkt um | Alle Endpunkte müssen beim konfigurierten Issuer liegen | umgesetzt |
| | Offener Redirect nach Login | `next` nur als Pfad dieser Seite (kein `//`, kein Schema, kein `\`) | umgesetzt |
| | Fälschung des Proxy-Headers | `X-Forwarded-For` zählt nur von `HERMES_WEBUI_TRUSTED_PROXIES`; Host-Header-Allowlist | umgesetzt |
| **T**ampering | CSRF auf schreibende Aufrufe | Sitzungs-Cookie `SameSite=Strict`, Origin-Prüfung, Pflicht-Header `X-Requested-With` | umgesetzt |
| | Ausgeliehene Sitzung (gestohlenes Cookie) | Sitzung nur serverseitig, Logout und Neuanmeldung machen sie ungültig, Leerlauf- und Höchstdauer, neue ID nach jedem Login | umgesetzt |
| | Dauerhafte Freigaben („immer erlauben“) per gekaperter Sitzung | **Step-up:** verlangt eine Anmeldung, die höchstens 10 Minuten alt ist | umgesetzt (siehe Grenzen) |
| | Manipulierte URL-Segmente erreichen fremde Upstream-Pfade | Strikte Muster für Host, Runtime, Agent und IDs; das BFF ruft nur konfigurierte Adressen | umgesetzt |
| | Eigene SVG-Symbole aus der Config (Sigils, Packs) | Nur Formen mit festen Attributen, kein `script`, `style`, `use`, `image`, keine `url(...)`, DOCTYPE oder ENTITY; höchstens 20 KB; Auslieferung aus dem Speicher (die URL wählt nie einen Dateipfad) mit `default-src 'none'; sandbox`; Darstellung nur als CSS-Maske, nie als Inline-SVG | umgesetzt |
| | XSS über Agent-Ausgabe | Markdown ohne rohes HTML, Links mit `rel=noopener noreferrer nofollow`, CSP ohne `unsafe-inline` und `unsafe-eval`, Bilder nur als geprüfte Data-URL | umgesetzt |
| **R**epudiation | „Das war ich nicht“ | Audit-Log (JSON-Zeilen, Datei 0600): Anmeldung, Abmeldung, Run-Start, Stopp, Freigabe, Steer, Rückfrage. Nur Umfang und Ziel, nie Inhalt, Keys oder Tokens. | umgesetzt |
| **I**nfo disclosure | Keys im Browser, in Logs oder Fehlermeldungen | Keys nur im BFF (Env), `repr` und Antworten enthalten sie nicht, Upstream-Fehler werden gekürzt, 401/403 der Runtime erscheinen als 502 | umgesetzt |
| | Cache- oder Frame-Leaks | `Cache-Control: no-store` auf `/bff/*` und `/auth/*`, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer`, COOP/CORP, HSTS in prod | umgesetzt |
| **D**enial of service | Run-Flut, Login-Flut, große Bodies | Rate-Limit je Nutzer und Agent, Rate-Limit und Obergrenze für offene Logins, Body-Limit, Upstream-Timeouts | umgesetzt |
| **E**levation | Dev-Modus in Produktion | `ENV=prod` verweigert den Start ohne OIDC, mit unvollständiger Konfiguration, mit `http`-Issuer oder `*` bei den Hosts; keine API-Doku in prod | umgesetzt |
| | Agent erreicht das BFF oder andere Dienste | Nicht Teil dieses Codes (Terminal-Backend und Firewall des Agents). Das BFF vertraut Runtimes nur als Datenquelle. | Betrieb |

## Bekannte Grenzen

- **Sitzungen liegen im Speicher.** Ein Neustart des BFF meldet ab. Für einen Einzelnutzer gewollt; bei mehreren Prozessen müsste der Speicher ersetzt werden.
- **Step-up ist „best effort“.** Das BFF verlangt `max_age=0` und `prompt=login`. Ob Forgejo eine neue Anmeldung erzwingt, hängt von dessen Verhalten ab; das BFF zählt die Zeit seit dem letzten Login-Abschluss. Vor dem Betrieb gegen die echte Forgejo-Instanz prüfen (Prüfpunkt Forgejo).
- **Forgejo liefert kein `auth_time`.** Live verifiziert am 23.10.2026 gegen `https://git.example.com/.well-known/openid-configuration`, Abschnitt `claims_supported`, Suchtext `auth_time`: die Liste enthält `aud`, `exp`, `iat`, `iss`, `sub`, `name`, `preferred_username`, `profile`, `picture`, `website`, `locale`, `updated_at`, `email`, `email_verified`, `groups`, aber kein `auth_time`. Deshalb gilt: Bietet die Discovery explizit `claims_supported` ohne `auth_time`, belegt ein frischer Step-up-Roundtrip (Callback innerhalb von `step_up_s` nach der Step-up-Anforderung) die erneute Anmeldung. Fehlt `claims_supported` oder ist die Fähigkeit unbekannt, bleibt fehlendes `auth_time` ein Fail-closed 401. Normales SSO ohne `auth_time` wird nie frisch.
- **Rate-Limits sind pro Prozess** und für einen Einzelnutzer gedacht.
- **Hermes-Eventformat und Key-Handling** stammen aus der Quelltext-Lesung, nicht aus einem Lauf mit Key (siehe README, offene Prüfpunkte).

## Noch nicht abgedeckt (kommt mit den Modulen)

- Host-Dienst auf dem Laptop (Phase 2): Pairing, ausgehende WSS-Verbindung mit eigener Authentifizierung, Verhalten bei Standby.
- Schreibende Verwaltungsaktionen (Config, Keys, Memory-Reset, Updates) mit Pflichtbestätigung und Step-up (Phase 5).
- Weitere Runtimes (Phase 4): OpenCode (Basic-Auth), Claude Code (Zugangsweg noch offen: Abo-Login der CLI oder Key, Nutzungsbedingungen vorab klären), Antigravity (keine Live-Freigaben).
