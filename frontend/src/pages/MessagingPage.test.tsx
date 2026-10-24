import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { installBackend } from "../test-backend";

let backend: ReturnType<typeof installBackend>;
async function open(prepare?: (b: ReturnType<typeof installBackend>) => void) {
  backend = installBackend(["gamma"]);
  prepare?.(backend);
  history.pushState(null, "", "/h/server/hermes/gamma/messaging");
  render(<App />);
  await screen.findByRole("heading", { name: "Messaging", level: 1 });
}
const sent = (method: string, suffix: string) => backend.calls.filter((c) => c.method === method && c.url.endsWith(suffix));
async function panel(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: `${name} einrichten` }));
  return await screen.findByRole("region", { name: `Einstellungen für ${name}` });
}

beforeEach(() => { resetRedirect(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Messaging-Plattformen", () => {
  it("lists the platforms the dashboard knows with their state", async () => {
    await open();
    const list = await screen.findByRole("list", { name: "Plattformen" });
    for (const name of ["Telegram", "Discord", "Slack"]) expect(within(list).getByText(name)).toBeInTheDocument();
    expect(within(list).getAllByText("aus")).toHaveLength(3);
  });

  it("says so when the host has no dashboard and offers nothing to change", async () => {
    await open((b) => { b.dash.msg.available = false; });
    expect(await screen.findByText(/kein Dashboard eingerichtet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /einrichten/ })).not.toBeInTheDocument();
  });

  it("configures a platform without ever showing the token, and sends only what changed", async () => {
    await open();
    const p = await panel("Telegram");
    const token = within(p).getByLabelText("TELEGRAM_BOT_TOKEN");
    expect(token).toHaveAttribute("type", "password");
    expect(token).toHaveAttribute("autocomplete", "off");
    fireEvent.change(token, { target: { value: " 123456:geheim-abc " } });
    fireEvent.change(within(p).getByLabelText("TELEGRAM_ALLOWED_USERS"), { target: { value: "1,2" } });
    fireEvent.click(within(p).getByLabelText("Plattform aktiv"));
    fireEvent.click(within(p).getByRole("button", { name: "Speichern" }));
    await within(p).findByText(/Gespeichert/);
    expect(sent("PUT", "/messaging/telegram")[0].body).toEqual({ enabled: true, env: { TELEGRAM_BOT_TOKEN: "123456:geheim-abc", TELEGRAM_ALLOWED_USERS: "1,2" } });
    expect(token).toHaveValue("");
    expect(document.body.textContent).not.toContain("geheim-abc");
    expect(within(p).getByText("gesetzt", { selector: ".tag" })).toBeInTheDocument();
    expect(screen.getByText("Gateway gestoppt")).toBeInTheDocument();
  });

  it("changes nothing that was not touched", async () => {
    await open((b) => { b.dash.msg.env = { TELEGRAM_BOT_TOKEN: "x:y", TELEGRAM_ALLOWED_USERS: "5" }; b.dash.msg.enabled.telegram = true; });
    const p = await panel("Telegram");
    expect(within(p).getByRole("button", { name: "Speichern" })).toBeDisabled();
    fireEvent.change(within(p).getByLabelText("TELEGRAM_ALLOWED_USERS"), { target: { value: "5,6" } });
    fireEvent.click(within(p).getByRole("button", { name: "Speichern" }));
    await within(p).findByText(/Gespeichert/);
    expect(sent("PUT", "/messaging/telegram")[0].body).toEqual({ env: { TELEGRAM_ALLOWED_USERS: "5,6" } });
  });

  it("does not send an untouched text field along with a changed token", async () => {
    await open((b) => { b.dash.msg.env = { TELEGRAM_BOT_TOKEN: "x:y", TELEGRAM_ALLOWED_USERS: "5" }; b.dash.msg.enabled.telegram = true; });
    const p = await panel("Telegram");
    expect(within(p).getByLabelText("TELEGRAM_ALLOWED_USERS")).toHaveValue("5");
    fireEvent.change(within(p).getByLabelText("TELEGRAM_BOT_TOKEN"), { target: { value: "9:neu" } });
    fireEvent.click(within(p).getByRole("button", { name: "Speichern" }));
    await within(p).findByText(/Gespeichert/);
    expect(sent("PUT", "/messaging/telegram")[0].body).toEqual({ env: { TELEGRAM_BOT_TOKEN: "9:neu" } });
    expect(backend.dash.msg.env.TELEGRAM_ALLOWED_USERS).toBe("5");
  });

  it("shows why Hermes refused a value", async () => {
    await open();
    const p = await panel("Telegram");
    fireEvent.change(within(p).getByLabelText("TELEGRAM_BOT_TOKEN"), { target: { value: "kein-token" } });
    fireEvent.click(within(p).getByRole("button", { name: "Speichern" }));
    expect(await within(p).findByRole("alert")).toHaveTextContent("complete token from @BotFather");
  });

  it("clears a token only after a second click", async () => {
    await open((b) => { b.dash.msg.env = { TELEGRAM_BOT_TOKEN: "x:y" }; });
    const p = await panel("Telegram");
    fireEvent.click(within(p).getByRole("button", { name: "TELEGRAM_BOT_TOKEN löschen" }));
    expect(sent("PUT", "/messaging/telegram")).toHaveLength(0);
    fireEvent.click(within(p).getByRole("button", { name: "Wirklich löschen" }));
    await within(p).findByText(/Gespeichert/);
    expect(sent("PUT", "/messaging/telegram")[0].body).toEqual({ clear_env: ["TELEGRAM_BOT_TOKEN"] });
    expect(backend.dash.msg.env).toEqual({});
  });

  it("checks the connection without changing anything", async () => {
    await open((b) => { b.dash.msg.env = { TELEGRAM_BOT_TOKEN: "x:y" }; b.dash.msg.enabled.telegram = true; });
    const p = await panel("Telegram");
    fireEvent.click(within(p).getByRole("button", { name: "Verbindung prüfen" }));
    expect(await within(p).findByText("Zustand: gateway_stopped")).toBeInTheDocument();
    expect(sent("PUT", "/messaging/telegram")).toHaveLength(0);
  });

  it("only links to web addresses", async () => {
    await open();
    const t = await panel("Telegram");
    expect(within(t).getByRole("link", { name: /Dokumentation/ })).toHaveAttribute("href", "https://core.telegram.org/bots/features#botfather");
    fireEvent.click(screen.getByRole("button", { name: "Telegram einrichten" }));
    const d = await panel("Discord");
    expect(within(d).queryByRole("link", { name: /Dokumentation/ })).not.toBeInTheDocument();
  });

  it("asks for a fresh login when a change needs one", async () => {
    await open((b) => { b.dash.stepUp = true; });
    const p = await panel("Slack");
    fireEvent.change(within(p).getByLabelText("SLACK_BOT_TOKEN"), { target: { value: "xoxb-1" } });
    fireEvent.click(within(p).getByRole("button", { name: "Speichern" }));
    expect(await within(p).findByRole("alert")).toHaveTextContent("frische Anmeldung");
  });
});

describe("Gateway", () => {
  const bar = () => screen.getByRole("region", { name: "Gateway" });

  it("shows whether the gateway runs and starts it, then says what happened", async () => {
    await open();
    expect(await within(bar()).findByText(/gestoppt/)).toBeInTheDocument();
    expect(within(bar()).queryByRole("button", { name: "Anhalten" })).not.toBeInTheDocument();
    fireEvent.click(within(bar()).getByRole("button", { name: "Gateway starten" }));
    expect(await within(bar()).findByText(/läuft/)).toBeInTheDocument();
    expect(sent("POST", "/gateway/start")).toHaveLength(1);
    expect(await within(bar()).findByText("Gateway gestartet")).toBeInTheDocument();
  });

  it("does not interrupt running sessions without an explicit confirmation", async () => {
    await open((b) => { b.dash.msg.gateway = { running: true, busy: true, sessions: 2 }; });
    expect(await within(bar()).findByText(/2 laufende Sitzungen/)).toBeInTheDocument();
    fireEvent.click(within(bar()).getByRole("button", { name: "Neu starten" }));
    expect(await within(bar()).findByRole("alert")).toHaveTextContent("unterbricht");
    expect(backend.dash.msg.gateway.sessions).toBe(2);
    fireEvent.click(within(bar()).getByRole("button", { name: "Trotzdem unterbrechen" }));
    await waitFor(() => expect(sent("POST", "/gateway/restart")).toHaveLength(2));
    expect(sent("POST", "/gateway/restart")[0].body).toEqual({ confirm_interrupt: false });
    expect(sent("POST", "/gateway/restart")[1].body).toEqual({ confirm_interrupt: true });
    await waitFor(() => expect(within(bar()).queryByRole("alert")).not.toBeInTheDocument());
  });

  it("restarts an idle gateway with one click", async () => {
    await open((b) => { b.dash.msg.gateway = { running: true, busy: false, sessions: 0 }; });
    fireEvent.click(await within(bar()).findByRole("button", { name: "Neu starten" }));
    await waitFor(() => expect(sent("POST", "/gateway/restart")).toHaveLength(1));
    expect(within(bar()).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("stops the gateway", async () => {
    await open((b) => { b.dash.msg.gateway = { running: true, busy: false, sessions: 0 }; });
    fireEvent.click(await within(bar()).findByRole("button", { name: "Anhalten" }));
    expect(await within(bar()).findByText(/gestoppt/)).toBeInTheDocument();
  });

  it("asks for a fresh login", async () => {
    await open((b) => { b.dash.stepUp = true; });
    fireEvent.click(await within(bar()).findByRole("button", { name: "Gateway starten" }));
    expect(await within(bar()).findByRole("alert")).toHaveTextContent("frische Anmeldung");
  });
});

describe("Telegram-Assistent", () => {
  it("walks from the bot link to a configured platform without the token reaching the browser", async () => {
    await open();
    const p = await panel("Telegram");
    fireEvent.click(within(p).getByRole("button", { name: "Bot mit Assistent einrichten" }));
    const link = await within(p).findByRole("link", { name: "In Telegram öffnen" });
    expect(link).toHaveAttribute("href", "https://t.me/newbot/hermes/hermes_test_bot");
    expect(await within(p).findByText(/Bot @hermes_test_bot ist bereit/)).toBeInTheDocument();
    const id = within(p).getByLabelText("Erlaubte Telegram-Nutzer-IDs");
    expect(id).toHaveValue("424242");
    fireEvent.change(id, { target: { value: "424242, 7" } });
    fireEvent.click(within(p).getByRole("button", { name: "Übernehmen" }));
    expect(await within(p).findByText(/Übernommen/)).toBeInTheDocument();
    expect(sent("POST", "/apply")[0].body).toEqual({ allowed_user_ids: ["424242", "7"] });
    expect(within(p).getByText(/Neustart nötig/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("SECRET-FROM-TELEGRAM");
    expect(backend.dash.msg.enabled.telegram).toBe(true);
  });

  it("accepts only numeric user IDs", async () => {
    await open();
    const p = await panel("Telegram");
    fireEvent.click(within(p).getByRole("button", { name: "Bot mit Assistent einrichten" }));
    const id = await within(p).findByLabelText("Erlaubte Telegram-Nutzer-IDs");
    for (const bad of ["abc", "12, x", "", "1;2"]) {
      fireEvent.change(id, { target: { value: bad } });
      expect(within(p).getByRole("button", { name: "Übernehmen" })).toBeDisabled();
    }
  });

  it("can be cancelled, which forgets the session at the dashboard", async () => {
    await open();
    const p = await panel("Telegram");
    fireEvent.click(within(p).getByRole("button", { name: "Bot mit Assistent einrichten" }));
    await within(p).findByRole("link", { name: "In Telegram öffnen" });
    fireEvent.click(within(p).getByRole("button", { name: "Abbrechen" }));
    await waitFor(() => expect(sent("DELETE", "/onboarding/pair_abc123")).toHaveLength(1));
    expect(within(p).queryByRole("link", { name: "In Telegram öffnen" })).not.toBeInTheDocument();
  });

  it("asks for a fresh login before it starts", async () => {
    await open((b) => { b.dash.stepUp = true; });
    const p = await panel("Telegram");
    fireEvent.click(within(p).getByRole("button", { name: "Bot mit Assistent einrichten" }));
    expect(await within(p).findByRole("alert")).toHaveTextContent("frische Anmeldung");
  });
});
