import { useSyncExternalStore } from "react";
import type { AgentRef } from "./types";

export type Page =
  | { name: "cockpit" }
  | { name: "inbox" }
  | { name: "hosts" }
  | { name: "terminal"; host: string }
  | { name: "workspace"; host: string }
  | { name: "operations"; section: "kanban" | "jobs" | "logs" | "manage" | "marketplaces" | "search"; host?: string }
  | { name: "settings" }
  | { name: "system" }
  | { name: "memory" }
  | { name: "providers" }
  | { name: "rooms" }
  | { name: "room"; id: string }
  | { name: "agent"; ref: AgentRef; module: string; sessionId?: string }
  | { name: "notfound" };

const dec = (s: string) => decodeURIComponent(s);
const enc = encodeURIComponent;

/** URL-Schema: / · /inbox · /hosts · /rooms[/<id>] · /memory · /providers · /system · /settings · /h/<host>/<runtime>/<agent>[/<modul>[/<id>]] (Modul `profil` bearbeitet das Profil) */
export function parsePath(pathname: string): Page {
  const parts = pathname.split("/").filter(Boolean);
  try {
    if (parts.length === 0) return { name: "cockpit" };
    const [head, ...rest] = parts;
    if (head === "inbox" && rest.length === 0) return { name: "inbox" };
    if (head === "hosts" && rest.length === 0) return { name: "hosts" };
    if (head === "hosts" && rest.length === 2 && (rest[1] === "terminal" || rest[1] === "workspace")) {
      return { name: rest[1], host: dec(rest[0]) };
    }
    if ((head === "kanban" || head === "jobs" || head === "logs" || head === "manage" || head === "marketplaces" || head === "search") && rest.length <= 1) {
      return { name: "operations", section: head, ...(rest.length ? { host: dec(rest[0]) } : {}) };
    }
    if (head === "settings" && rest.length === 0) return { name: "settings" };
    if (head === "system" && rest.length === 0) return { name: "system" };
    if (head === "memory" && rest.length === 0) return { name: "memory" };
    if (head === "providers" && rest.length === 0) return { name: "providers" };
    if (head === "rooms" && rest.length === 0) return { name: "rooms" };
    if (head === "rooms" && rest.length === 1) return { name: "room", id: dec(rest[0]) };
    if (head === "h" && rest.length >= 3) {
      const [host, runtime, agent, module = "chat", sessionId] = rest.map(dec);
      return { name: "agent", ref: { host, runtime, agent }, module, sessionId };
    }
  } catch {
    // ungültige Prozent-Kodierung
  }
  return { name: "notfound" };
}

export const agentPath = (a: AgentRef, module = "chat", sessionId?: string) =>
  `/h/${enc(a.host)}/${enc(a.runtime)}/${enc(a.agent)}/${enc(module)}${sessionId ? `/${enc(sessionId)}` : ""}`;

export const sameAgent = (a?: AgentRef, b?: AgentRef) =>
  !!a && !!b && a.host === b.host && a.runtime === b.runtime && a.agent === b.agent;

export const agentKey = (a: AgentRef) => `${a.host}/${a.runtime}/${a.agent}`;

// --- Navigation ohne Router-Bibliothek: History-API plus ein Ereignis für Links innerhalb der App ---
const NAV_EVENT = "hermes:navigate";

export function navigate(to: string, replace = false) {
  if (to === location.pathname + location.search) return;
  history[replace ? "replaceState" : "pushState"](null, "", to);
  dispatchEvent(new Event(NAV_EVENT));
}

function subscribe(cb: () => void) {
  addEventListener("popstate", cb);
  addEventListener(NAV_EVENT, cb);
  return () => {
    removeEventListener("popstate", cb);
    removeEventListener(NAV_EVENT, cb);
  };
}

const snapshot = () => location.pathname;

export function usePath(): string {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
