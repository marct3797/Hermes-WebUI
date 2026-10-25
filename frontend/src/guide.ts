import type { AgentRef } from "./types";
import { api } from "./api";
import { extApi } from "./extApi";
import { N_, t } from "./i18n";

export type GuideCheck = { ok: boolean; text: string };

/** Bedienfeld je Eintrag: die Seite stellt Hermes direkt, ohne Befehl. */
export type GuidePanel =
  | "whatsapp" | "terminal" | "tools" | "computeruse" | "update"
  | "gateway" | "hooks" | "env" | "mcp" | "memory";

export type GuideEntry = {
  id: string;
  title: string;
  purpose: string;
  /** Seite, die das Thema einstellt ("messaging", "providers", "hermes-memory", "extensions", "system"). */
  configurePath: string;
  /** Linktext zur Einstellungsseite. */
  configureLabel: string;
  panel: GuidePanel;
  run: ((a: AgentRef) => Promise<GuideCheck>) | null;
};

// Texte sind mit N_ markiert und werden in der Seite mit t() angezeigt.
// Belege je Eintrag: Hermes-Quelltext v0.22.5, Datei:Zeile im Kommentar (Routen gegen die web_routers geprüft).
export const GUIDE: GuideEntry[] = [
  {
    // BFF: POST/GET/POST/DELETE /messaging/whatsapp/onboarding* (Hermes: web_routers/messaging.py:629-739)
    id: "whatsapp", title: N_("WhatsApp koppeln"), purpose: N_("WhatsApp als Kanal einrichten und per QR-Code koppeln — Start, Stand und Freigabe laufen hier."),
    configurePath: "messaging", configureLabel: N_("Zu Messaging"), panel: "whatsapp",
    run: async (a) => {
      const r = await api.messaging(a);
      const hit = r.platforms.find((p) => p.id === "whatsapp") ?? r.platforms[0];
      return hit ? { ok: hit.state === "connected", text: t("{name}: {state}", { name: hit.name, state: hit.state ?? t("unbekannt") }) } : { ok: false, text: t("Keine Plattform gefunden") };
    },
  },
  {
    // BFF: PUT /terminal-backend (Hermes: PUT /api/tools/terminal/backend, tools.py:672)
    id: "terminal", title: N_("Terminal-Backend wechseln"), purpose: N_("Wählen, wo Befehle laufen: lokal, im Container oder auf einem fremden Rechner."),
    configurePath: "extensions", configureLabel: N_("Zu den Erweiterungen"), panel: "terminal",
    run: async (a) => {
      const r = await api.terminalBackends(a);
      return { ok: true, text: t("Aktives Backend: {name}", { name: r.active ?? t("unbekannt") }) };
    },
  },
  {
    // BFF: POST /tools/{name}/post-setup (Hermes: tools.py:621, Hintergrundaktion)
    id: "tools", title: N_("Werkzeug nachinstallieren"), purpose: N_("Fehlende Abhängigkeiten eines Werkzeugs nachholen, etwa für den Browser."),
    configurePath: "extensions", configureLabel: N_("Zu den Erweiterungen"), panel: "tools",
    run: async (a) => {
      const r = await api.tools(a);
      const on = r.toolsets.filter((row) => row.enabled).length;
      return { ok: true, text: t("{on} von {all} Werkzeuggruppen aktiv", { on, all: r.toolsets.length }) };
    },
  },
  {
    // BFF: GET/POST /computer-use/* (Hermes: tools.py:696-709; auf Linux antwortet Hermes mit Begründung)
    id: "computeruse", title: N_("Computer-Use-Rechte vergeben"), purpose: N_("Dem Treiber erlauben, Bildschirm und Eingaben zu steuern."),
    configurePath: "extensions", configureLabel: N_("Zu den Erweiterungen"), panel: "computeruse",
    run: async (a) => {
      const r = await api.computerUse(a);
      return { ok: !!r.ready, text: t("Computer Use: {state}", { state: r.ready ? t("bereit") : (r.detail ?? t("aus")) }) };
    },
  },
  {
    // BFF: GET/POST /hermes-ops/update* (Hermes: actions.py:241-289, Hintergrundaktion)
    id: "update", title: N_("Hermes aktualisieren"), purpose: N_("Prüfen, ob eine neue Version bereitsteht, und sie einspielen."),
    configurePath: "system", configureLabel: N_("Zum System"), panel: "update",
    run: async (a) => {
      const r = await api.updateCheck(a);
      return { ok: !r.available, text: r.available ? t("Neu: {v}", { v: r.available }) : t("Stand: {v}", { v: r.current }) };
    },
  },
  {
    // BFF: GET/POST /gateway/migrate* (Hermes: actions.py:169-186, Hintergrundaktion)
    id: "gateway", title: N_("Gateway umziehen"), purpose: N_("Alle Profil-Gateways auf das eine Host-Gateway zusammenführen."),
    configurePath: "messaging", configureLabel: N_("Zu Messaging"), panel: "gateway",
    run: async (a) => {
      const r = await api.gateway(a);
      return { ok: r.running, text: r.running ? t("Gateway läuft ({n} Sitzungen)", { n: r.active_sessions }) : t("läuft nicht") };
    },
  },
  {
    // BFF: GET/POST/DELETE /hermes-hooks (Hermes: ops.py:673-800)
    id: "hooks", title: N_("Hooks einrichten"), purpose: N_("Eigene Skripte an Ereignisse koppeln, etwa vor einem Werkzeugaufruf. Befehle laufen mit deinen Rechten."),
    configurePath: "extensions", configureLabel: N_("Zu den Erweiterungen"), panel: "hooks",
    run: async (a) => {
      const r = await api.shellHooks(a);
      return { ok: true, text: t("{n} Hooks", { n: r.hooks.length }) };
    },
  },
  {
    // BFF: DELETE /env/{key} (Hermes: DELETE /api/env, config_env.py:1067); Setzen läuft über die Anbieterseite
    id: "env", title: N_("Schlüssel in der .env prüfen und löschen"), purpose: N_("Schlüssel setzen läuft auf der Anbieterseite, löschen geht hier mit eingetipptem Namen."),
    configurePath: "providers", configureLabel: N_("Zu den Anbietern"), panel: "env",
    run: async (a) => {
      const r = await api.hermesConfig(a);
      return { ok: true, text: t("{n} Einstellungen geladen", { n: r.fields.length }) };
    },
  },
  {
    // BFF: PUT /mcp (Hermes: PUT /api/mcp/servers, mcp.py:160); Test je Server in den Erweiterungen
    id: "mcp", title: N_("MCP-Liste als Ganzes ersetzen"), purpose: N_("Die komplette Liste der MCP-Server neu aufsetzen. Ersetzt alles auf einmal."),
    configurePath: "extensions", configureLabel: N_("Zu den Erweiterungen"), panel: "mcp",
    run: async (a) => {
      const r = await extApi.mcp(a.host, a.agent);
      return { ok: true, text: t("{n} MCP-Server", { n: r.servers.length }) };
    },
  },
  {
    // BFF: PUT /hermes-memory/provider + POST /hermes-memory/providers/{name}/setup
    id: "memory", title: N_("Speicher-Anbieter einrichten"), purpose: N_("Einen externen Speicher wie Hindsight oder Mem0 anbinden: Programm installieren und Anbieter wählen."),
    configurePath: "hermes-memory", configureLabel: N_("Zum Hermes-Gedächtnis"), panel: "memory",
    run: async (a) => {
      const r = await api.hmOverview(a);
      return { ok: r.active !== "", text: t("Aktiver Speicher: {name}", { name: r.active || t("keiner") }) };
    },
  },
];
