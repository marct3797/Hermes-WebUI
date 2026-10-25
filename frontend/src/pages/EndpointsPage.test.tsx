import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { installBackend } from "../test-backend";

let backend: ReturnType<typeof installBackend>;
async function open() {
  backend = installBackend(["gamma"]);
  history.pushState(null, "", "/h/server/hermes/gamma/endpunkte");
  render(<App />);
  await screen.findByRole("heading", { name: "Eigene Endpunkte", level: 1 });
}
const sent = (method: string, part: string) => backend.calls.filter((c) => c.method === method && c.url.includes(part));
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => { resetRedirect(); sessionStorage.clear(); });
afterEach(() => { cleanup(); });

describe("Eigene Endpunkte", () => {
  it("shows delegation backend, endpoints and local models without any key", async () => {
    await open();
    await waitFor(async () => expect(await screen.findByRole("combobox", { name: "Backend" })).toHaveValue("default"));
    expect(screen.getByRole("region", { name: "Lokale Modelle" }).textContent).toContain("llama3.gguf");
    expect(document.body.textContent).not.toMatch(/sk-[a-z]/i);
  });

  it("blocks unsafe addresses in the browser and never sends them", async () => {
    await open();
    await screen.findByRole("combobox", { name: "Backend" });
    fill("Name", "X"); fill("Adresse", "http://user:pw@host/v1"); fill("Endpunkt-Modell", "m");
    expect(screen.getByRole("button", { name: "Endpunkt speichern" })).toBeDisabled();
    expect(screen.getByText(/Nur http\(s\)-Adressen/)).toBeInTheDocument();
    expect(sent("POST", "/hermes-endpoints")).toHaveLength(0);
  });

  it("saves, activates and deletes only after typing the id; key field is cleared", async () => {
    await open();
    await screen.findByRole("combobox", { name: "Backend" });
    fill("Name", "Mein Ollama"); fill("Adresse", "http://127.0.0.1:11434/v1"); fill("Endpunkt-Modell", "llama3"); fill("Schlüssel", "sk-secret-1");
    fireEvent.click(screen.getByRole("button", { name: "Endpunkt speichern" }));
    await screen.findByText(/Schlüssel gesetzt/);
    expect(screen.getByLabelText("Schlüssel")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Aktivieren Mein Ollama" }));
    await screen.findByText(/· aktiv/);
    const del = screen.getByRole("button", { name: "Löschen Mein Ollama" });
    expect(del).toBeDisabled();
    fireEvent.change(screen.getByLabelText("ID zum Löschen Mein Ollama"), { target: { value: "mein-ollama" } });
    fireEvent.click(screen.getByRole("button", { name: "Löschen Mein Ollama" }));
    await waitFor(() => expect(screen.queryByText(/Schlüssel gesetzt/)).toBeNull());
    expect(sent("DELETE", "confirm=mein-ollama")).toHaveLength(1);
  });

  it("masks the key field", async () => {
    await open();
    await screen.findByRole("combobox", { name: "Backend" });
    expect(screen.getByLabelText("Schlüssel")).toHaveAttribute("type", "password");
  });

  it("changes the delegation backend", async () => {
    await open();
    fireEvent.change(await screen.findByRole("combobox", { name: "Backend" }), { target: { value: "docker" } });
    await waitFor(() => expect(sent("PUT", "/hermes-delegation/backend")).toHaveLength(1));
  });
});
