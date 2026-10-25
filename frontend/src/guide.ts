import type { AgentRef } from "./types";
import { ApiError, api } from "./api";
import { extApi } from "./extApi";
import { N_, t } from "./i18n";

export type GuideCheck = { ok: boolean; text: string };

/** Aktion, die eine bestehende BFF-Schreib-Route ruft. Niemals Shell-Befehle aus dem Browser. */
export type GuideExecute = {
  /** Knopftext, z. B. N_("WhatsApp testen"). */
  label: string;
  /** Bestätigungstext für window.confirm; null ohne Nachfrage. */
  confirm: string | null;
  /** Führt die Schreib-Route aus und prüft den Nachher-Zustand über eine Lese-Route. */
  call: (a: AgentRef) => Promise<GuideCheck>;
};

/** Aufklappbare Notlösung: reiner Befehl mit ehrlicher Begründung, warum er nur am Rechner läuft. */
export type GuideNoExecute = {
  /** Warum die Weboberfläche das nicht ausführt (keine BFF-Schreib-Route). */
  whyNot: string;
  command: string;
  caution: string;
};

export type GuideEntry = {
  id: string;
  title: string;
  purpose: string;
  /** Seite, die das Thema einstellt ("messaging", "providers", "hermes-memory", "extensions", "system", "assistant"). */
  configurePath: string;
  /** Linktext zur Einstellungsseite. */
  configureLabel: string;
  execute: GuideExecute | null;
  noExecute: GuideNoExecute | null;
  run: ((a: AgentRef) => Promise<GuideCheck>) | null;
};

// Texte sind mit N_ markiert und werden in der Seite mit t() angezeigt. Befehle sind feste Texte ohne Nutzerdaten.
// Belege je Eintrag: Hermes-Quelltext v0.22.5, Datei:Zeile im Kommentar (Befehlsnamen gegen die argparse-Definitionen geprüft).
export const GUIDE: GuideEntry[] = [
  {
    // hermes_cli/subcommands/whatsapp.py:10-12; website/docs/reference/cli-commands.md:445-451
    // BFF: PUT /messaging/{platform} (Schlüssel setzen), POST /messaging/{platform}/test (Verbindung testen) in backend/app/routes/messaging.py
    id: "whatsapp", title: N_("WhatsApp koppeln"), purpose: N_("WhatsApp als Kanal einrichten und per QR-Code koppeln."),
    configurePath: "messaging", configureLabel: N_("Zu Messaging"),
    execute: {
      label: N_("WhatsApp testen"),
      confirm: null,
      call: async (a) => {
        const r = await api.testMessaging(a, "whatsapp");
        return { ok: r.ok, text: r.message || t("{name}: {state}", { name: "WhatsApp", state: r.state ?? t("unbekannt") }) };
      },
    },
    noExecute: {
      whyNot: N_("Der QR-Code braucht ein eigenes Terminalfenster und läuft nicht über den Browser. Schlüssel und Test laufen hier, koppeln am Rechner."),
      command: "hermes whatsapp", caution: N_("Der Code gilt nur kurz. Zeige ihn niemandem."),
    },
    run: async (a) => {
      const r = await api.messaging(a);
      const hit = r.platforms.find((p) => p.id === "whatsapp") ?? r.platforms[0];
      return hit ? { ok: hit.state === "connected", text: t("{name}: {state}", { name: hit.name, state: hit.state ?? t("unbekannt") }) } : { ok: false, text: t("Keine Plattform gefunden") };
    },
  },
  {
    // hermes_cli/subcommands/setup.py:17 (Abschnitt `terminal`); setup_terminal.py:272; cli-commands.md:891 (`config set terminal.backend`)
    // BFF: nur GET /terminal-backends — keine Schreib-Route, daher kein execute.
    id: "terminal", title: N_("Terminal-Backend wechseln"), purpose: N_("Wählen, wo Befehle laufen: lokal, im Container oder auf einem fremden Rechner."),
    configurePath: "extensions", configureLabel: N_("Zu den Erweiterungen"),
    execute: null,
    noExecute: {
      whyNot: N_("Ein falsches Backend hebt die Isolation auf. Das stellt man nur am Rechner selbst um; die WebUI hat dafür keine Schreib-Route."),
      command: "hermes setup terminal", caution: N_("Lokal heißt: Befehle laufen direkt auf dem Rechner, ohne Isolation."),
    },
    run: async (a) => {
      const r = await api.terminalBackends(a);
      return { ok: true, text: t("Aktives Backend: {name}", { name: r.active ?? t("unbekannt") }) };
    },
  },
  {
    // hermes_cli/subcommands/tools.py:39-48 (`post-setup KEY`)
    // BFF: PUT /tools/{name} (einschalten, ggf. mit Installations-Zustimmung) in backend/app/routes/tools.py
    id: "tools", title: N_("Werkzeug nachinstallieren"), purpose: N_("Fehlende Abhängigkeiten eines Werkzeugs nachholen, etwa für den Browser."),
    configurePath: "extensions", configureLabel: N_("Zu den Erweiterungen"),
    execute: {
      label: N_("Fehlende Einrichtung starten"),
      confirm: N_("Fehlende Werkzeug-Einrichtung über die Weboberfläche starten?"),
      call: async (a) => {
        const r = await api.tools(a);
        const needy = r.toolsets.find((row) => !row.enabled && !row.configured);
        if (!needy) return { ok: true, text: t("Nichts nachzuinstallieren") };
        try {
          await api.toggleTool(a, needy.name, true);
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            await api.toggleTool(a, needy.name, true, true);
          } else throw e;
        }
        const after = await api.tools(a);
        const still = after.toolsets.find((row) => row.name === needy.name);
        return { ok: !!still?.enabled, text: t("{name}: {state}", { name: still?.label ?? needy.name, state: still?.enabled ? t("aktiv") : t("aus") }) };
      },
    },
    noExecute: {
      whyNot: N_("Die Nachinstallation lädt Programme aus dem Netz und braucht ein Terminal. Die WebUI startet sie nur, wenn Hermes sie als fehlend meldet."),
      command: "hermes tools post-setup <schlüssel>", caution: N_("Lädt Software aus dem Netz. Nur ausführen, wenn du der Quelle vertraust. Den Schlüssel nennt die Werkzeugseite bei Status „Einrichtung nötig“."),
    },
    run: async (a) => {
      const r = await api.tools(a);
      const on = r.toolsets.filter((row) => row.enabled).length;
      return { ok: true, text: t("{on} von {all} Werkzeuggruppen aktiv", { on, all: r.toolsets.length }) };
    },
  },
  {
    // hermes_cli/subcommands/computer_use.py:127-171 (install, status, doctor, permissions); cli-commands.md:1703-1718
    // BFF: keine Schreib-Route für OS-Rechte — daher kein execute.
    id: "computeruse", title: N_("Computer-Use-Rechte vergeben"), purpose: N_("Dem Treiber erlauben, Bildschirm und Eingaben zu steuern."),
    configurePath: "extensions", configureLabel: N_("Zu den Erweiterungen"),
    execute: null,
    noExecute: {
      whyNot: N_("Betriebssystem-Rechte lassen sich nur am Rechner selbst bestätigen, nicht aus dem Browser. Die WebUI hat dafür keine Schreib-Route."),
      command: "hermes computer-use install", caution: N_("Gibt Hermes Zugriff auf Bildschirm und Eingaben. Nur auf dem eigenen Rechner."),
    },
    run: async (a) => {
      const r = await api.tools(a);
      const cu = r.toolsets.find((row) => row.name === "computer_use");
      return { ok: !!cu?.enabled, text: cu ? t("Computer Use: {state}", { state: cu.enabled ? t("aktiv") : t("aus") }) : t("Computer Use nicht gefunden") };
    },
  },
  {
    // hermes_cli/subcommands/update.py:19 (`--check`); main.py:2336,2351; cli-commands.md:2007-2016
    // BFF: keine Schreib-Route für Updates — daher kein execute.
    id: "update", title: N_("Hermes aktualisieren"), purpose: N_("Prüfen, ob eine neue Version bereitsteht, und sie einspielen."),
    configurePath: "system", configureLabel: N_("Zum System"),
    execute: null,
    noExecute: {
      whyNot: N_("Das Update ersetzt laufende Dateien. Das steuert nur der Rechner selbst; die WebUI hat dafür keine Schreib-Route."),
      command: "hermes update --check", caution: N_("Erst prüfen, dann einspielen: ohne --check wird die neue Version wirklich installiert."),
    },
    run: async (a) => {
      const r = await api.dashboard(a);
      return { ok: r.available, text: r.available ? t("Dashboard erreichbar") : (r.reason ?? t("nicht erreichbar")) };
    },
  },
  {
    // hermes_cli/subcommands/gateway.py:204-215 (`migrate`, `--dry-run`, `-y`); cli-commands.md:307-327
    // BFF: POST /gateway/start|stop|restart in backend/app/routes/messaging.py (kein migrate — der Umzug selbst bleibt CLI)
    id: "gateway", title: N_("Gateway umziehen"), purpose: N_("Alle Profil-Gateways auf das eine Host-Gateway zusammenführen."),
    configurePath: "messaging", configureLabel: N_("Zu Messaging"),
    execute: {
      label: N_("Gateway starten"),
      confirm: N_("Gateway über die Weboberfläche starten?"),
      call: async (a) => {
        await api.gatewayAction(a, "start");
        const r = await api.gateway(a);
        return { ok: r.running, text: r.running ? t("Gateway läuft ({n} Sitzungen)", { n: r.active_sessions }) : t("Gateway steht") };
      },
    },
    noExecute: {
      whyNot: N_("Der Umzug startet Dienste neu und unterbricht laufende Chats. Die Zusammenführung selbst läuft am Rechner; starten geht auch hier."),
      command: "hermes gateway migrate --dry-run", caution: N_("Zeigt zuerst nur den Plan. Anwenden erst nach dem Lesen, mit -y."),
    },
    run: async (a) => {
      const r = await api.gateway(a);
      return { ok: r.running, text: r.running ? t("Gateway läuft ({n} Sitzungen)", { n: r.active_sessions }) : t("Gateway steht") };
    },
  },
  {
    // hermes_cli/subcommands/hooks.py:10-40 (list, test, revoke, doctor); cli-commands.md:1553-1566
    // BFF: keine Schreib-Route für Hook-Skripte (nur Zugang/Webhooks) — daher kein execute.
    id: "hooks", title: N_("Hooks einrichten"), purpose: N_("Eigene Skripte an Ereignisse koppeln, etwa vor einem Werkzeugaufruf."),
    configurePath: "extensions", configureLabel: N_("Zu den Erweiterungen"),
    execute: null,
    noExecute: {
      whyNot: N_("Hooks führen Shell-Befehle aus. Die gehören in Dateien am Rechner, nicht in den Browser. Die WebUI hat dafür keine Schreib-Route."),
      command: "hermes hooks list", caution: N_("Hooks laufen mit deinen Rechten. Prüfe jedes Skript, bevor du es freigibst."),
    },
    run: async (a) => {
      const r = await api.acHooks(a);
      return { ok: true, text: t("{n} Hooks, Freigabe {state}", { n: r.subscriptions.length, state: r.enabled ? t("an") : t("aus") }) };
    },
  },
  {
    // hermes_cli/subcommands/config.py:27-41 (`set NAME wert`, `env-path`); cli-commands.md:1352 (UPPER_SNAKE-Namen gehen in die .env)
    // BFF: PUT /providers/key (Schlüssel setzen), kein Lesen/Löschen im Klartext — daher kein execute fürs Löschen.
    id: "env", title: N_("Schlüssel in der .env prüfen und löschen"), purpose: N_("Sehen, wo die .env liegt, und Schlüssel dort ändern oder entfernen."),
    configurePath: "providers", configureLabel: N_("Zu den Anbietern"),
    execute: null,
    noExecute: {
      whyNot: N_("Die WebUI zeigt Schlüssel nie im Klartext und löscht sie nicht aus Versehen. Setzen geht auf der Anbieterseite, Löschen nur am Rechner."),
      command: "hermes config env-path", caution: N_("Teile Schlüssel nie. Entfernen wirkt erst nach einem Neustart."),
    },
    run: async (a) => {
      const r = await api.hermesConfig(a);
      return { ok: true, text: t("{n} Einstellungen geladen", { n: r.fields.length }) };
    },
  },
  {
    // hermes_cli/subcommands/mcp.py (`add`, `add ... --env`, `list`); cli-commands.md: Abschnitt MCP
    // BFF: keine Schreib-Route für die MCP-Liste als Ganzes — daher kein execute.
    id: "mcp", title: N_("MCP-Liste als Ganzes ersetzen"), purpose: N_("Die komplette Liste der MCP-Server neu aufsetzen."),
    configurePath: "extensions", configureLabel: N_("Zu den Erweiterungen"),
    execute: null,
    noExecute: {
      whyNot: N_("Die Liste als Ganzes zu ersetzen löscht alle Server auf einmal. Das geht nur am Rechner; die WebUI hat dafür keine Schreib-Route."),
      command: "hermes mcp list", caution: N_("Ersetzen löscht alles. Erst auflisten und sichern, dann ersetzen."),
    },
    run: async (a) => {
      const r = await extApi.mcp(a.host, a.agent);
      return { ok: true, text: t("{n} MCP-Server", { n: r.servers.length }) };
    },
  },
  {
    // hermes_cli/subcommands/hermes_memory.py (provider set); Website: externer Speicher (Hindsight, Mem0)
    // BFF: PUT /hermes-memory/provider, PUT /hermes-memory/providers/{name} in backend/app/routes/hermes_memory.py
    id: "memory", title: N_("Speicher-Anbieter einrichten"), purpose: N_("Einen externen Speicher wie Hindsight oder Mem0 anbinden."),
    configurePath: "hermes-memory", configureLabel: N_("Zum Hermes-Gedächtnis"),
    execute: {
      label: N_("Standard-Speicher wählen"),
      confirm: N_("Externen Standardspeicher über die Weboberfläche wählen? Schlüssel setzt du danach auf der Gedächtnisseite."),
      call: async (a) => {
        const before = await api.hmOverview(a);
        const fallback = before.providers.find((p) => p.available && p.name !== before.active) ?? before.providers.find((p) => p.available);
        if (!fallback) return { ok: before.active !== "", text: t("Aktiver Speicher: {name}", { name: before.active || t("keiner") }) };
        await api.hmSetProvider(a, fallback.name);
        const after = await api.hmOverview(a);
        return { ok: after.active === fallback.name, text: t("Aktiver Speicher: {name}", { name: after.active }) };
      },
    },
    noExecute: {
      whyNot: N_("Schlüssel gehören auf die Gedächtnisseite, nicht in einen Befehl. Der Anbieterwechsel geht auch hier."),
      command: "hermes hermes-memory provider --help", caution: N_("Schlüssel nie in Befehle schreiben. Erst Anbieter wählen, dann Schlüssel auf der Gedächtnisseite setzen."),
    },
    run: async (a) => {
      const r = await api.hmOverview(a);
      return { ok: r.active !== "", text: t("Aktiver Speicher: {name}", { name: r.active || t("keiner") }) };
    },
  },
];
