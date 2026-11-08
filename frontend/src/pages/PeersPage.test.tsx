import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { installBackend } from "../test-backend";

beforeEach(() => { resetRedirect(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function open(off = false) {
  const backend = installBackend(["gamma"]);
  backend.dash.peers.off = off;
  history.pushState(null, "", "/h/server/hermes/gamma/peers");
  render(<App />);
  await screen.findByRole("heading", { name: "Bot-Modus und Peers", level: 1 });
  return backend;
}
const type = (name: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(name), { target: { value } });

describe("Bot-Modus und Peers", () => {
  it("trägt einen Peer ein, leert die Maske und zeigt nie den Schlüssel", async () => {
    const backend = await open();
    await screen.findByRole("button", { name: "Entfernen spark" });
    type("Name des Peers", "lab"); type("Adresse des Peers", "http://lab.lan:8377");
    const save = screen.getByRole("button", { name: "Peer speichern" });
    expect(save).toBeDisabled();
    type("API-Schlüssel des Peers", "TOP-SECRET");
    expect((screen.getByLabelText("API-Schlüssel des Peers") as HTMLInputElement).type).toBe("password");
    fireEvent.click(save);
    await screen.findByRole("button", { name: "Entfernen lab" });
    expect(backend.dash.peers.keys).toEqual(["TOP-SECRET"]);
    expect((screen.getByLabelText("API-Schlüssel des Peers") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain("TOP-SECRET");
  });

  it("entfernt erst nach dem eingetippten Namen", async () => {
    const backend = await open();
    await screen.findByRole("button", { name: "Entfernen spark" });
    const del = screen.getByRole("button", { name: "Entfernen spark" });
    expect(del).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Zum Entfernen den Namen eintippen: spark"), { target: { value: "spark" } });
    fireEvent.click(del);
    await waitFor(() => expect(backend.dash.peers.rows).toHaveLength(0));
  });

  it("sendet an einen Peer, holt den Status und stoppt", async () => {
    const backend = await open();
    await screen.findByRole("button", { name: "Entfernen spark" });
    type("Agent beim Peer", "researcher");
    const send = screen.getByRole("button", { name: "An spark/researcher senden" });
    expect(send).toBeDisabled();
    type("Nachricht an den Peer", "Hallo");
    fireEvent.click(send);
    await screen.findByRole("button", { name: "Status von run_1" });
    expect(backend.dash.peers.sent).toMatchObject([{ target: "spark/researcher", message: "Hallo" }]);
    expect((screen.getByLabelText("Nachricht an den Peer") as HTMLTextAreaElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Status von run_1" }));
    expect((await screen.findByLabelText("Antwort run_1")).textContent).toContain("Antwort vom Peer");
    fireEvent.click(screen.getByRole("button", { name: "Lauf run_1 stoppen" }));
    await waitFor(() => expect(screen.getByText(/stopped/)).toBeTruthy());
  });

  it("nennt den fehlenden Schalter in hostd", async () => {
    await open(true);
    expect((await screen.findAllByText(/allow_peers/)).length).toBeGreaterThan(0);
  });
});
