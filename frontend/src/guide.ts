import type { AgentRef } from "./types";
import { api } from "./api";
import { extApi } from "./extApi";
import { N_, t } from "./i18n";

export type GuideCheck = { ok: boolean; text: string };

export type GuideEntry = {
  id: string;
  title: string;
  purpose: string;
  whyNot: string;
  command: string;
  caution: string;
  /** Ohne Lese-Route: statt des Knopfes ein Link zur Seite, auf der man das Ergebnis sieht. */
  linkHref: string | null;
  linkLabel: string | null;
  run: ((a: AgentRef) => Promise<GuideCheck>) | null;
};

// Texte sind mit N_ markiert und werden in der Seite mit t() angezeigt. Befehle sind feste Texte ohne Nutzerdaten.
// Belege je Eintrag: Hermes-Quelltext v0.22.5, Datei:Zeile im Kommentar (Befehlsnamen gegen die argparse-Definitionen geprüft).
export const GUIDE: GuideEntry[] = [
  {
    // hermes_cli/subcommands/whatsapp.py:10-12; website/docs/reference/cli-commands.md:445-451
    id: "whatsapp", title: N_("WhatsApp koppeln"), purpose: N_("WhatsApp als Kanal einrichten und per QR-Code koppeln."),
    whyNot: N_("Der QR-Code braucht ein eigenes Terminalfenster und läuft nicht über den Browser."),
    command: "hermes whatsapp", caution: N_("Der Code gilt nur kurz. Zeige ihn niemandem."),
    linkHref: null, linkLabel: null,
    run: async (a) => {
      const r = await api.messaging(a);
      const hit = r.platforms.find((p) => p.id === "whatsapp") ?? r.platforms[0];
      return hit ? { ok: hit.state === "connected", text: t("{name}: {state}", { name: hit.name, state: hit.state ?? t("unbekannt") }) } : { ok: false, text: t("Keine Plattform gefunden") };
    },
  },
  {
    // hermes_cli/subcommands/setup.py:17 (Abschnitt `terminal`); setup_terminal.py:272; cli-commands.md:891 (`config set terminal.backend`)
    id: "terminal", title: N_("Terminal-Backend wechseln"), purpose: N_("Wählen, wo Befehle laufen: lokal, im Container oder auf einem fremden Rechner."),
    whyNot: N_("Ein falsches Backend hebt die Isolation auf. Das stellt man nur am Rechner selbst um."),
    command: "hermes setup terminal", caution: N_("Lokal heißt: Befehle laufen direkt auf dem Rechner, ohne Isolation."),
    linkHref: null, linkLabel: null,
    run: async (a) => {
      const r = await api.terminalBackends(a);
      return { ok: true, text: t("Aktives Backend: {name}", { name: r.active ?? t("unbekannt") }) };
    },
  },
  {
    // hermes_cli/subcommands/tools.py:39-48 (`post-setup KEY`)
    id: "tools", title: N_("Werkzeug nachinstallieren"), purpose: N_("Fehlende Abhängigkeiten eines Werkzeugs nachholen, etwa für den Browser."),
    whyNot: N_("Die Nachinstallation lädt Programme aus dem Netz und braucht ein Terminal."),
    command: "hermes tools post-setup <schlüssel>", caution: N_("Lädt Software aus dem Netz. Nur ausführen, wenn du der Quelle vertraust. Den Schlüssel nennt die Werkzeugseite bei Status „Einrichtung nötig“."),
    linkHref: null, linkLabel: null,
    run: async (a) => {
      const r = await api.tools(a);
      const on = r.toolsets.filter((row) => row.enabled).length;
      return { ok: true, text: t("{on} von {all} Werkzeuggruppen aktiv", { on, all: r.toolsets.length }) };
    },
  },
  {
    // hermes_cli/subcommands/computer_use.py:127-171 (install, status, doctor, permissions); cli-commands.md:1703-1718
    id: "computeruse", title: N_("Computer-Use-Rechte vergeben"), purpose: N_("Dem Treiber erlauben, Bildschirm und Eingaben zu steuern."),
    whyNot: N_("Betriebssystem-Rechte lassen sich nur am Rechner selbst bestätigen, nicht aus dem Browser."),
    command: "hermes computer-use install", caution: N_("Gibt Hermes Zugriff auf Bildschirm und Eingaben. Nur auf dem eigenen Rechner."),
    linkHref: null, linkLabel: null,
    run: async (a) => {
      const r = await api.tools(a);
      const cu = r.toolsets.find((row) => row.name === "computer_use");
      return { ok: !!cu?.enabled, text: cu ? t("Computer Use: {state}", { state: cu.enabled ? t("aktiv") : t("aus") }) : t("Computer Use nicht gefunden") };
    },
  },
  {
    // hermes_cli/subcommands/update.py:19 (`--check`); main.py:2336,2351; cli-commands.md:2007-2016
    id: "update", title: N_("Hermes aktualisieren"), purpose: N_("Prüfen, ob eine neue Version bereitsteht, und sie einspielen."),
    whyNot: N_("Das Update ersetzt laufende Dateien. Das steuert nur der Rechner selbst."),
    command: "hermes update --check", caution: N_("Erst prüfen, dann einspielen: ohne --check wird die neue Version wirklich installiert."),
    linkHref: null, linkLabel: null,
    run: async (a) => {
      const r = await api.dashboard(a);
      return { ok: r.available, text: r.available ? t("Dashboard erreichbar") : (r.reason ?? t("nicht erreichbar")) };
    },
  },
  {
    // hermes_cli/subcommands/gateway.py:204-215 (`migrate`, `--dry-run`, `-y`); cli-commands.md:307-327
    id: "gateway", title: N_("Gateway umziehen"), purpose: N_("Alle Profil-Gateways auf das eine Host-Gateway zusammenführen."),
    whyNot: N_("Der Umzug startet Dienste neu und unterbricht laufende Chats."),
    command: "hermes gateway migrate --dry-run", caution: N_("Zeigt zuerst nur den Plan. Anwenden erst nach dem Lesen, mit -y."),
    linkHref: null, linkLabel: null,
    run: async (a) => {
      const r = await api.gateway(a);
      return { ok: r.running, text: r.running ? t("Gateway läuft ({n} Sitzungen)", { n: r.active_sessions }) : t("Gateway steht") };
    },
  },
  {
    // hermes_cli/subcommands/hooks.py:10-40 (list, test, revoke, doctor); cli-commands.md:1553-1566
    id: "hooks", title: N_("Hooks einrichten"), purpose: N_("Eigene Skripte an Ereignisse koppeln, etwa vor einem Werkzeugaufruf."),
    whyNot: N_("Hooks führen Shell-Befehle aus. Die gehören in Dateien am Rechner, nicht in den Browser."),
    command: "hermes hooks list", caution: N_("Hooks laufen mit deinen Rechten. Prüfe jedes Skript, bevor du es freigibst."),
    linkHref: null, linkLabel: null,
    run: async (a) => {
      const r = await api.acHooks(a);
      return { ok: true, text: t("{n} Hooks, Freigabe {state}", { n: r.subscriptions.length, state: r.enabled ? t("an") : t("aus") }) };
    },
  },
  {
    // hermes_cli/subcommands/config.py:27-41 (`set NAME wert`, `env-path`); cli-commands.md:1352 (UPPER_SNAKE-Namen gehen in die .env)
    id: "env", title: N_("Schlüssel in der .env prüfen und löschen"), purpose: N_("Sehen, wo die .env liegt, und Schlüssel dort ändern oder entfernen."),
    whyNot: N_("Die WebUI zeigt Schlüssel nie im Klartext und löscht sie nicht aus Versehen."),
    command: "hermes config env-path", caution: N_("Teile Schlüssel nie. Entfernen wirkt sofort auf alle Läufe. Setzen geht mit hermes config set NAME wert."),
    linkHref: "/providers", linkLabel: N_("Ob ein Schlüssel gesetzt ist, siehst du unter Anbieter:"),
    run: null,
  },
  {
    // hermes_cli/subcommands/config.py:18 (`edit`); hermes_cli/subcommands/mcp.py:39-41 (`list`, `test`); Abschnitt mcp_servers der config.yaml
    id: "mcp", title: N_("MCP-Liste als Ganzes ersetzen"), purpose: N_("Die komplette Liste der MCP-Server neu aufsetzen."),
    whyNot: N_("Ein falscher Eintrag kappt alle Werkzeuge auf einmal. Darum nur als Ganzes am Rechner."),
    command: "hermes config edit", caution: N_("Bearbeite den Abschnitt mcp_servers und sichere vorher die alte Datei. Danach mit hermes mcp list prüfen."),
    linkHref: null, linkLabel: null,
    run: async (a) => {
      const r = await extApi.mcp(a.host, a.agent);
      return { ok: true, text: t("{n} MCP-Server eingetragen", { n: r.servers.length }) };
    },
  },
  {
    // hermes_cli/subcommands/memory.py:12-28 (setup, status, off); memory_setup.py:81; cli-commands.md:1570-1584
    id: "memory", title: N_("Speicher-Anbieter einrichten"), purpose: N_("Einen externen Speicher wie Hindsight oder Mem0 anbinden."),
    whyNot: N_("Das Setup führt Installer-Befehle der Anbieter aus und fragt geheime Schlüssel ab."),
    command: "hermes memory setup", caution: N_("Anbieter-Schlüssel gehören nur ins Terminal, nie in den Browser oder in einen Chat."),
    linkHref: null, linkLabel: null,
    run: async (a) => {
      const r = await api.hmOverview(a);
      return { ok: true, text: t("Aktiver Speicher: {name}", { name: r.active }) };
    },
  },
];
