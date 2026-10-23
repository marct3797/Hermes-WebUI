import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { page, resetRedirect } from "./api";
import type { HostInfo } from "./types";

const HOSTS: HostInfo[] = [
  { id: "hikari", label: "Hikari", kind: "local", address: null, status: "online", detail: null, runtimes: [
    { id: "hermes", label: "Hermes", status: "online", version: "0.20.4", detail: null, multiplex: true,
      agents: [{ id: "raiden", label: "raiden" }, { id: "sora", label: "sora" }] }] },
  { id: "laptop", label: "Laptop", kind: "remote", address: "100.100.3.4", status: "unreachable", detail: "Host-Dienst nicht verbunden (folgt in Phase 2)", runtimes: [
    { id: "hermes", label: "Hermes", status: "unreachable", version: null, detail: "Host-Dienst nicht verbunden (folgt in Phase 2)", multiplex: false,
      agents: [{ id: "default", label: "default" }] }] },
];

type Routes = Record<string, { status?: number; body: unknown }>;

function fakeBackend(overrides: Routes = {}) {
  const routes: Routes = {
    "/bff/me": { body: { user: { id: "42", name: "marc" }, auth_mode: "oidc", fresh: true } },
    "/bff/hosts": { body: { hosts: HOSTS, config_error: null } },
    "/bff/ui": { body: { ui: { backgroundShader: { enabled: true, strength: 1.6, speed: 1 } }, sigils: {
      raiden: { type: "glyph", glyph: "neutral/bolt", hue: 98 }, "laptop/hermes/default": { type: "initials", text: "LT", hue: null },
    }, warnings: [], error: null } },
    "/bff/h/hikari/hermes/raiden/status": { body: { state: "online", online: true, version: "0.20.4", features: ["runs"], error: null } },
    "/bff/h/hikari/hermes/raiden/models": { body: { models: [{ id: "mock-large" }] } },
    "/bff/h/hikari/hermes/raiden/sessions": { body: { sessions: [{ id: "s1", title: "Erster Chat" }] } },
    "/bff/h/hikari/hermes/sora/status": { body: { state: "auth_error", online: false, version: null, features: [], error: "Key abgelehnt oder fehlt" } },
    "/bff/h/hikari/hermes/sora/sessions": { status: 502, body: { detail: "x" } },
    ...overrides,
  };
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    const r = routes[url];
    if (!r) return new Response(JSON.stringify({ detail: "nicht da" }), { status: 404 });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }));
  return calls;
}

const open = (path: string) => history.pushState(null, "", path);

beforeEach(() => resetRedirect());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("App-Shell", () => {
  it("groups agents by host and marks the offline host", async () => {
    fakeBackend();
    open("/");
    render(<App />);
    const side = await screen.findByRole("complementary", { name: "Navigation" });
    const hikari = await within(side).findByRole("region", { name: "Hikari" });
    expect(within(hikari).getByRole("link", { name: /raiden/ })).toHaveAttribute("href", "/h/hikari/hermes/raiden/chat");
    expect(within(hikari).getByRole("link", { name: /sora/ })).toBeInTheDocument();
    const laptop = within(side).getByRole("region", { name: "Laptop" });
    expect(within(laptop).getByText("remote")).toBeInTheDocument();
    expect(within(laptop).getByText(/Host-Dienst nicht verbunden/)).toBeInTheDocument();
    for (const name of ["Cockpit", "Inbox", "Hosts"]) expect(within(side).getByRole("link", { name })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Alle Agents" })).toBeInTheDocument();
  });

  it("draws sigils from the UI config and falls back to initials without an entry", async () => {
    fakeBackend();
    open("/");
    render(<App />);
    const side = await screen.findByRole("complementary", { name: "Navigation" });
    const raiden = (await within(side).findByRole("link", { name: /raiden/ })).querySelector(".sg") as HTMLElement;
    await waitFor(() => expect(raiden.style.getPropertyValue("--g")).toBe("var(--i-bolt)"));
    expect(raiden.style.getPropertyValue("--id")).toBe("oklch(.82 .12 98)");
    expect(raiden).not.toHaveClass("ini");
    // kein Eintrag: Initialen und Farbton aus dem Namen
    const sora = within(side).getByRole("link", { name: /sora/ }).querySelector(".sg") as HTMLElement;
    expect(sora).toHaveClass("ini");
    expect(sora).toHaveAttribute("data-i", "SO");
    // Eintrag nur für diesen Host: Initialen aus der Config, neutral eingefärbt
    const laptop = within(side).getByRole("link", { name: /default/ }).querySelector(".sg") as HTMLElement;
    await waitFor(() => expect(laptop).toHaveAttribute("data-i", "LT"));
    expect(laptop.style.getPropertyValue("--id")).toBe("oklch(.92 0 0)");
  });

  it("keeps working without a UI config", async () => {
    fakeBackend({ "/bff/ui": { status: 404, body: { detail: "nicht da" } } });
    open("/");
    render(<App />);
    const side = await screen.findByRole("complementary", { name: "Navigation" });
    expect(await within(side).findByRole("link", { name: /raiden/ })).toBeInTheDocument();
    expect(side.querySelectorAll(".sg.ini").length).toBe(3);
  });

  it("shows the user and offers logout only with login enabled", async () => {
    fakeBackend();
    open("/hosts");
    render(<App />);
    expect(await screen.findByText("marc")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Abmelden" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Hikari" })).toBeInTheDocument();
    expect(screen.getByText("0.20.4")).toBeInTheDocument();
  });

  it("opens the chat of an online agent with its sessions", async () => {
    fakeBackend();
    open("/h/hikari/hermes/raiden/chat");
    render(<App />);
    expect(await screen.findByPlaceholderText("Nachricht an raiden…")).toBeEnabled();
    // Die Session-Spalte zeigt die Liste; die Schublade der Seitenleiste (nur auf schmalen Schirmen sichtbar) führt dieselben Ziele.
    const column = await screen.findByRole("complementary", { name: "Sessions von raiden" });
    expect(await within(column).findByRole("link", { name: /Erster Chat/ })).toHaveAttribute("href", "/h/hikari/hermes/raiden/chat/s1");
    expect(await screen.findByText("Hermes 0.20.4")).toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: "Modell" })).toBeInTheDocument();
  });

  it("disables the composer and explains why when the agent is not usable", async () => {
    fakeBackend();
    open("/h/hikari/hermes/sora/chat");
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Zugangsschlüssel/);
    // Entwurf tippen bleibt möglich, Senden nicht.
    fireEvent.change(screen.getByPlaceholderText("sora ist nicht erreichbar"), { target: { value: "hallo" } });
    expect(screen.getByRole("button", { name: "Senden" })).toBeDisabled();
  });

  it("shows a clear notice for an agent that no longer exists", async () => {
    fakeBackend();
    open("/h/hikari/hermes/geloescht/chat");
    render(<App />);
    expect(await screen.findByRole("heading", { name: /Der Agent „geloescht“ auf hikari gibt es nicht/ })).toBeInTheDocument();
  });

  it("maps old /p/<profil> links onto the new scheme", async () => {
    fakeBackend();
    open("/p/raiden/chat");
    render(<App />);
    expect(await screen.findByPlaceholderText("Nachricht an raiden…")).toBeInTheDocument();
    expect(location.pathname).toBe("/h/hikari/hermes/raiden/chat");
  });

  it("navigates without reloading when a link is clicked", async () => {
    fakeBackend();
    open("/");
    render(<App />);
    fireEvent.click(await within(await screen.findByRole("complementary", { name: "Navigation" })).findByRole("link", { name: "Inbox" }));
    expect(await screen.findByRole("heading", { name: "Braucht dich", level: 1 })).toBeInTheDocument();
    expect(location.pathname).toBe("/inbox");
  });
});

describe("Anmeldung", () => {
  it("sends the visitor to the login when the session is missing", async () => {
    fakeBackend({ "/bff/me": { status: 401, body: { detail: "Nicht angemeldet" } } });
    const assign = vi.spyOn(page, "assign").mockImplementation(() => undefined);
    open("/h/hikari/hermes/raiden/chat/s1");
    render(<App />);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/auth/login?next=%2Fh%2Fhikari%2Fhermes%2Fraiden%2Fchat%2Fs1"));
    expect(await screen.findByText("Weiterleitung zur Anmeldung…")).toBeInTheDocument();
  });

  it("reports an unreachable BFF instead of looping", async () => {
    fakeBackend({ "/bff/me": { status: 500, body: { detail: "kaputt" } } });
    open("/");
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/BFF ist nicht erreichbar/);
  });
});
