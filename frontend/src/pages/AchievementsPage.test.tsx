import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { installBackend } from "../test-backend";

let backend: ReturnType<typeof installBackend>;
async function open(path: string, heading: string) {
  backend = installBackend(["gamma"]);
  history.pushState(null, "", path);
  render(<App />);
  await screen.findByRole("heading", { name: heading, level: 1 });
}
const sent = (method: string, part: string) => backend.calls.filter((c) => c.method === method && c.url.includes(part));
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
beforeEach(() => { resetRedirect(); sessionStorage.clear(); vi.spyOn(window, "confirm").mockReturnValue(true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Erfolge", () => {
  it("shows progress and keeps secret achievements hidden", async () => {
    await open("/achievements", "Erfolge");
    await screen.findByText(/1 von 3 freigeschaltet/);
    expect(document.body.textContent).toContain("???");
  });

  it("shows the scan state, the latest unlocks and the badges of one session", async () => {
    await open("/achievements", "Erfolge");
    await screen.findByText(/Letzte Prüfung abgeschlossen \(2 Läufe\)/);
    expect(await screen.findByRole("region", { name: "Zuletzt freigeschaltet" })).toHaveTextContent("Let Him Cook");
    const go = screen.getByRole("button", { name: "Erfolge prüfen" });
    expect(go).toBeDisabled();
    type("Sitzungs-ID", "s1");
    fireEvent.click(go);
    expect(await screen.findByRole("list", { name: "Erfolge dieser Sitzung" })).toHaveTextContent("Let Him Cook");
    type("Sitzungs-ID", "s2");
    fireEvent.click(screen.getByRole("button", { name: "Erfolge prüfen" }));
    await screen.findByText("Diese Sitzung schaltet nichts frei.");
  });

  it("resets only after typing reset", async () => {
    await open("/achievements", "Erfolge");
    await screen.findByText(/1 von 3 freigeschaltet/);
    const btn = screen.getByRole("button", { name: "Alle Freischaltungen zurücksetzen" });
    expect(btn).toBeDisabled();
    type("Zurücksetzen bestätigen", "reset");
    fireEvent.click(screen.getByRole("button", { name: "Alle Freischaltungen zurücksetzen" }));
    await screen.findByText(/0 von 3 freigeschaltet/);
    expect(sent("POST", "/_achievements/reset")[0].body).toEqual({ confirm: "reset" });
  });

  it("rescans on request", async () => {
    await open("/achievements", "Erfolge");
    fireEvent.click(await screen.findByRole("button", { name: "Neu scannen" }));
    await waitFor(() => expect(sent("POST", "/_achievements/rescan")).toHaveLength(1));
  });

  it("says when the values are stale", async () => {
    backend = installBackend(["gamma"]);
    backend.dash.p3.stale = true;
    history.pushState(null, "", "/achievements");
    render(<App />);
    await screen.findByText(/Die Werte sind veraltet/);
  });
});
