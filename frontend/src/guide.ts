import type { AgentRef } from "./types";
import { api } from "./api";
import { extApi } from "./extApi";

export type GuideCheck = { ok: boolean; text: string };

export type GuideEntry = {
  id: string;
  title: string;
  purpose: string;
  whyNot: string;
  command: string;
  caution: string;
  /** Les route id for "Ergebnis pruefen"; null = link fallback instead of button. */
  checkKind:
    | "messaging" | "terminal" | "tools" | "dashboard" | "gateway"
    | "hooks" | "models" | "mcp" | "memory" | null;
  linkHref: string | null;
  linkLabel: string | null;
  run: ((a: AgentRef) => Promise<GuideCheck>) | null;
};

// Belege (Hermes-Quelltext v0.22.5): Datei:Zeile als Kommentar je Eintrag.
export const GUIDE: GuideEntry[] = [
  {
    // whatsapp.py:10-12; cli-commands.md:445-451
    id: "whatsapp", title: "WhatsApp koppeln", purpose: "WhatsApp als Kanal einrichten und per QR-Code koppeln.",
    whyNot: "Der QR-Code braucht ein eigenes Terminalfenster und laeuft nicht ueber den Browser.",
    command: "hermes whatsapp", caution: "Der Code gilt nur kurz. Niemandem zeigen.",
    checkKind: "messaging", linkHref: null, linkLabel: null,
    run: async (a) => {
      const r = await api.messaging(a);
      const hit = r.platforms.find((p) => p.id === "whatsapp") ?? r.platforms[0];
      return hit ? { ok: hit.state === "connected", text: `${hit.name}: ${hit.state ?? "unbekannt"}` } : { ok: false, text: "Keine Plattform gefunden" };
    },
  },
  {
    // setup_terminal.py:1,125-136,272 (setup_terminal_backend); web_routers/tools.py:645,672
    id: "terminal", title: "Terminal-Backend wechseln", purpose: "Waehlen, wo Befehle laufen: lokal, Container oder entfernt.",
    whyNot: "Ein falsches Backend hebt die Isolation auf. Das stellt nur ein Assistent am Rechner um.",
    command: "hermes setup terminal", caution: "Lokal heisst: Befehle laufen direkt auf dem Rechner ohne Isolation.",
    checkKind: "terminal", linkHref: null, linkLabel: null,
    run: async (a) => {
      const r = await api.terminalBackends(a);
      return { ok: true, text: `Aktives Backend: ${r.active ?? "unbekannt"}` };
    },
  },
  {
    // tools.py:39 (post-setup); computer_use.py:89-122,127,144,149-171
    id: "tools", title: "Werkzeug nachinstallieren", purpose: "Fehlende Werkzeug-Abhaengigkeiten nachholen, etwa fuer Computer Use.",
    whyNot: "Die Nachinstallation laedt Programme aus dem Netz und braucht ein Terminal.",
    command: "hermes tools post-setup agent_browser", caution: "Laedt Software aus dem Netz. Nur ausfuehren, wenn du der Quelle vertraust.",
    checkKind: "tools", linkHref: null, linkLabel: null,
    run: async (a) => {
      const r = await api.tools(a);
      const on = r.toolsets.filter((row) => row.enabled).length;
      return { ok: true, text: `${on} von ${r.toolsets.length} Werkzeuggruppen aktiv` };
    },
  },
  {
    // computer_use.py install/status/permissions; cli-commands.md:1703-1718
    id: "computeruse", title: "Computer-Use-Rechte vergeben", purpose: "Dem Treiber erlauben, Bildschirm und Eingaben zu steuern.",
    whyNot: "Betriebssystem-Rechte lassen sich nur am Rechner selbst bestaetigen, nicht aus dem Browser.",
    command: "hermes computer-use install", caution: "Gibt Hermes Zugriff auf Bildschirm und Eingaben. Nur auf dem eigenen Rechner.",
    checkKind: "tools", linkHref: null, linkLabel: null,
    run: async (a) => {
      const r = await api.tools(a);
      const cu = r.toolsets.find((row) => row.name === "computer_use");
      return { ok: !!cu?.enabled, text: cu ? `Computer Use: ${cu.enabled ? "aktiv" : "aus"}` : "Computer Use nicht gefunden" };
    },
  },
  {
    // main.py:2336,2351; cli-commands.md:2007-2016 (hermes update [--check])
    id: "update", title: "Hermes aktualisieren", purpose: "Pruefen, ob eine neue Version bereitsteht, und sie einspielen.",
    whyNot: "Das Update ersetzt laufende Dateien. Das steuert nur der Rechner selbst.",
    command: "hermes update --check", caution: "Vor dem echten Update laeuft nichts mehr nebenbei. Erst pruefen, dann einspielen.",
    checkKind: "dashboard", linkHref: null, linkLabel: null,
    run: async (a) => {
      const r = await api.dashboard(a);
      return { ok: r.available, text: r.available ? "Dashboard erreichbar" : (r.reason ?? "nicht erreichbar") };
    },
  },
  {
    // gateway.py:65,70-71,141,146,205; cli-commands.md:307-327
    id: "gateway", title: "Gateway leeren und umziehen", purpose: "Nachrichten-Gateway pruefen und Profile auf das Host-Gateway falten.",
    whyNot: "Der Umzug startet Dienste neu und unterbricht laufende Chats.",
    command: "hermes gateway migrate --dry-run", caution: "Erst mit --dry-run schauen, was sich aendert. Echte Umzuege nur mit -y.",
    checkKind: "gateway", linkHref: null, linkLabel: null,
    run: async (a) => {
      const r = await api.gateway(a);
      return { ok: r.running, text: r.running ? `Gateway laeuft (${r.active_sessions} Sitzungen)` : "Gateway steht" };
    },
  },
  {
    // hooks.py:10-27; cli-commands.md:1553-1566; web_routers/ops.py:673,722,773
    id: "hooks", title: "Hooks einrichten", purpose: "Eigene Skripte an Ereignisse koppeln, etwa vor einem Werkzeugaufruf.",
    whyNot: "Hooks fuehren Shell-Befehle aus. Die gehoeren in Dateien am Rechner, nicht in den Browser.",
    command: "hermes hooks list", caution: "Hooks laufen mit deinen Rechten. Pruefe jedes Skript vor dem Freigeben.",
    checkKind: "hooks", linkHref: null, linkLabel: null,
    run: async (a) => {
      const r = await api.acHooks(a);
      return { ok: true, text: `${r.subscriptions.length} Hooks, Freigabe ${r.enabled ? "an" : "aus"}` };
    },
  },
  {
    // config_env.py:259,328,1067,1085; secrets_cli.py:70,79
    id: "env", title: "Schluessel in der .env pruefen und loeschen", purpose: "Sehen, welche Schluessel liegen, und ungueltige entfernen.",
    whyNot: "Die WebUI zeigt Schluessel nie im Klartext und loescht sie nicht aus Versehen.",
    command: "hermes secrets bitwarden status", caution: "Schluessel nie kopieren oder teilen. Loeschen wirkt sofort auf alle Laeufe.",
    checkKind: null, linkHref: "/providers", linkLabel: "Ergebnis siehst du unter Anbieter",
    run: null,
  },
  {
    // web_routers/local_models.py:534-952 (status/hardware/catalog/install/download/server/activate)
    id: "models", title: "Lokale Modelle installieren", purpose: "Ein Modell auf den Rechner laden und lokal starten.",
    whyNot: "Modelle sind mehrere Gigabyte gross und brauchen viel Speicher und Zeit.",
    command: "hermes model download llama3", caution: "Braucht mehrere Gigabyte Platz und dauert je nach Leitung lange.",
    checkKind: "models", linkHref: null, linkLabel: null,
    run: async (a) => {
      const r = await api.epLocal(a);
      return { ok: r.server_running, text: `${r.models.length} Modelle, Server ${r.server_running ? "laeuft" : "steht"}` };
    },
  },
  {
    // mcp.py:11-39; cli-commands.md:1613-1632
    id: "mcp", title: "MCP-Liste als Ganzes ersetzen", purpose: "Die komplette Liste der Modell-Kontext-Server neu aufsetzen.",
    whyNot: "Ein falscher Eintrag kappt alle Werkzeuge auf einmal. Darum nur als Ganzes am Rechner.",
    command: "hermes mcp list", caution: "Vor dem Ersetzen die alte Liste sichern. Fehler treffen alle Server zugleich.",
    checkKind: "mcp", linkHref: null, linkLabel: null,
    run: async (a) => {
      const r = await extApi.mcp(a.host, a.agent);
      return { ok: true, text: `${r.servers.length} MCP-Server eingetragen` };
    },
  },
  {
    // memory_setup.py:81; memory.py:10-34 (memory setup/status); cli-commands.md:1570-1584
    id: "memory", title: "Speicher-Anbieter einrichten", purpose: "Einen externen Speicher wie Hindsight oder Mem0 anbinden.",
    whyNot: "Das Setup fuehrt Installer-Befehle der Anbieter aus und fragt geheime Schluessel ab.",
    command: "hermes memory setup", caution: "Anbieter-Schluessel gehoeren nur ins Terminal, nie in den Browser oder Chat.",
    checkKind: "memory", linkHref: null, linkLabel: null,
    run: async (a) => {
      const r = await api.hmOverview(a);
      return { ok: true, text: `Aktiver Speicher: ${r.active}` };
    },
  },
];
