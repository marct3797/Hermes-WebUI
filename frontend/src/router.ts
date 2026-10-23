import { useSyncExternalStore } from "react";
import type { AgentRef } from "./types";

/** Host, auf den alte /p/<profil>-Links zeigen (entspricht HERMES_WEBUI_LEGACY_HOST im BFF). */
export const LEGACY_HOST = "hikari";

export type Page =
  | { name: "cockpit" }
  | { name: "inbox" }
  | { name: "hosts" }
  | { name: "settings" }
  | { name: "system" }
  | { name: "agent"; ref: AgentRef; module: string; sessionId?: string }
  | { name: "redirect"; to: string }
  | { name: "notfound" };

const dec = (s: string) => decodeURIComponent(s);
const enc = encodeURIComponent;

/** URL-Schema: / · /inbox · /hosts · /system · /settings · /h/<host>/<runtime>/<agent>[/<modul>[/<id>]] (Modul `profil` bearbeitet das Profil) */
export function parsePath(pathname: string): Page {
  const parts = pathname.split("/").filter(Boolean);
  try {
    if (parts.length === 0) return { name: "cockpit" };
    const [head, ...rest] = parts;
    if (head === "inbox" && rest.length === 0) return { name: "inbox" };
    if (head === "hosts" && rest.length === 0) return { name: "hosts" };
    if (head === "settings" && rest.length === 0) return { name: "settings" };
    if (head === "system" && rest.length === 0) return { name: "system" };
    if (head === "h" && rest.length >= 3) {
      const [host, runtime, agent, module = "chat", sessionId] = rest.map(dec);
      return { name: "agent", ref: { host, runtime, agent }, module, sessionId };
    }
    if (head === "p" && rest.length >= 1) {
      // Alte Links /p/<profil>/chat/<id> gehören Hermes auf dem Standard-Host.
      const [profile, ...tail] = rest;
      return { name: "redirect", to: `/h/${LEGACY_HOST}/hermes/${profile}/${tail.length ? tail.join("/") : "chat"}` };
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
