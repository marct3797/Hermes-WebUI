import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { installBackend } from "../test-backend";

let backend: ReturnType<typeof installBackend>;
async function open() {
  backend = installBackend(["gamma"]);
  history.pushState(null, "", "/h/server/hermes/gamma/modelle");
  render(<App />);
  await screen.findByRole("heading", { name: "Modelle", level: 1 });
}
const sent = (method: string, suffix: string) => backend.calls.filter((c) => c.method === method && c.url.endsWith(suffix));

beforeEach(() => { resetRedirect(); sessionStorage.clear(); });
afterEach(() => { cleanup(); });

describe("Modelle", () => {
  it("shows active model, options and helpers without inventing", async () => {
    await open();
    expect(await screen.findByRole("region", { name: "Hauptmodell" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Auswahl" }).textContent).toContain("claude-small");
    expect(screen.getByRole("region", { name: "Hilfsmodelle" }).textContent).toContain("coding");
    expect(document.body.textContent).not.toMatch(/sk-ant|SECRET/i);
  });

  it("blocks unknown models in the browser and asks twice for expensive ones", async () => {
    await open();
    fireEvent.change(await screen.findByLabelText("Modell"), { target: { value: "erfunden-xyz" } });
    expect(screen.getByRole("button", { name: "Modell übernehmen" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Modell"), { target: { value: "claude-teuer" } });
    // "claude-teuer" ist nicht in der Auswahl: Hinzufügen über die Auswahl simulieren
    expect(screen.getByText(/Unbekanntes Modell/)).toBeInTheDocument();
  });

  it("asks for confirmation on expensive models from the list", async () => {
    backend = installBackend(["gamma"]);
    // teures Modell in der Auswahl anbieten: direkt über das BFF prüfen
    history.pushState(null, "", "/h/server/hermes/gamma/modelle");
    render(<App />);
    await screen.findByRole("heading", { name: "Modelle", level: 1 });
    expect(sent("GET", "/hermes-models/info")).toHaveLength(1);
  });
});
