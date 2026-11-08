import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import { resetRedirect } from "../../api";
import { installBackend } from "../../test-backend";

let backend: ReturnType<typeof installBackend>;
async function open() {
  backend = installBackend(["gamma"]);
  history.pushState(null, "", "/h/server/hermes/gamma/tools");
  render(<App />);
  await screen.findByRole("heading", { name: "Werkzeuge", level: 1 });
  await screen.findByRole("button", { name: "Web einrichten" });
}
const writes = (suffix = "") => backend.calls.filter((c) => c.method === "PUT" && c.url.includes("/tools/") && c.url.endsWith(suffix));
async function panel(label: string) {
  fireEvent.click(screen.getByRole("button", { name: `${label} einrichten` }));
  return await screen.findByRole("region", { name: `Einstellungen für ${label}` });
}

beforeEach(() => { resetRedirect(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Werkzeuge einrichten", () => {
  it("counts the toolsets the dashboard reports and offers setup for each", async () => {
    await open();
    expect(screen.getByText("gamma · 2 von 4 aktiv")).toBeInTheDocument();
    for (const label of ["Terminal", "Web", "Bilder", "Computer Use"]) expect(screen.getByRole("button", { name: `${label} einrichten` })).toBeInTheDocument();
  });

  it("stays read-only when the host has no dashboard", async () => {
    backend = installBackend(["gamma"]);
    backend.dash.tools.available = false;
    history.pushState(null, "", "/h/server/hermes/gamma/tools");
    render(<App />);
    await screen.findByText("Terminal", { selector: "b" });
    expect(screen.queryByRole("button", { name: /einrichten/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Terminal-Backend/)).not.toBeInTheDocument();
  });

  it("switches a toolset on and updates the count", async () => {
    await open();
    const p = await panel("Web");
    fireEvent.click(within(p).getByRole("button", { name: "Einschalten" }));
    await within(p).findByRole("button", { name: "Ausschalten" });
    expect(writes()[0].body).toEqual({ enabled: true, accept_install: false });
    expect(screen.getByText("gamma · 3 von 4 aktiv")).toBeInTheDocument();
  });

  it("asks for consent before something may be installed, and only then sends it", async () => {
    await open();
    const p = await panel("Computer Use");
    fireEvent.click(within(p).getByRole("button", { name: "Einschalten" }));
    expect(await within(p).findByRole("alert")).toHaveTextContent("kann Software installieren");
    expect(writes()).toHaveLength(1);
    expect(backend.dash.tools.enabled.computer_use).toBe(false);
    fireEvent.click(within(p).getByRole("button", { name: "Zustimmen und einschalten" }));
    await within(p).findByRole("button", { name: "Ausschalten" });
    expect(writes()[1].body).toEqual({ enabled: true, accept_install: true });
  });

  it("saves a key without ever showing it, and shows only that it is set", async () => {
    await open();
    const p = await panel("Web");
    const field = within(p).getByLabelText("BRAVE_SEARCH_API_KEY");
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "off");
    expect(within(p).getAllByText("nicht gesetzt")).toHaveLength(2);
    fireEvent.change(field, { target: { value: "  geheimer-wert-4711 " } });
    fireEvent.click(within(p).getByRole("button", { name: "BRAVE_SEARCH_API_KEY speichern" }));
    await waitFor(() => expect(within(p).getAllByText("gesetzt")).toHaveLength(1));
    expect(writes("/env")[0].body).toEqual({ env: { BRAVE_SEARCH_API_KEY: "geheimer-wert-4711" } });
    expect(field).toHaveValue("");
    expect(document.body.textContent).not.toContain("geheimer-wert-4711");
  });

  it("does not send an empty key field", async () => {
    await open();
    const p = await panel("Web");
    expect(within(p).getByRole("button", { name: "BRAVE_SEARCH_API_KEY speichern" })).toBeDisabled();
  });

  it("shows the reason when the dashboard refuses a key", async () => {
    await open();
    const p = await panel("Web");
    fireEvent.change(within(p).getByLabelText("BRAVE_SEARCH_API_KEY"), { target: { value: "abgelehnt" } });
    fireEvent.click(within(p).getByRole("button", { name: "BRAVE_SEARCH_API_KEY speichern" }));
    expect(await within(p).findByRole("alert")).toHaveTextContent("geschwärzte Vorschau");
    expect(backend.dash.tools.keys).toEqual({});
  });

  it("only turns links into anchors when they are web addresses", async () => {
    await open();
    const p = await panel("Web");
    expect(within(p).getByRole("link", { name: /Brave Search API key anlegen|Key beim Anbieter anlegen/ })).toHaveAttribute("href", "https://brave.com/search/api/");
    expect(p.querySelectorAll('a[href^="javascript"]')).toHaveLength(0);
  });

  it("chooses the provider, and for web also which part it serves", async () => {
    await open();
    const p = await panel("Web");
    fireEvent.click(within(p).getByRole("button", { name: "Firecrawl Cloud für Extraktion wählen" }));
    await waitFor(() => expect(writes("/provider")).toHaveLength(1));
    expect(writes("/provider")[0].body).toEqual({ provider: "Firecrawl Cloud", capability: "extract" });
    fireEvent.click(within(p).getByRole("button", { name: "Brave Search (Free) wählen" }));
    await waitFor(() => expect(writes("/provider")).toHaveLength(2));
    expect(writes("/provider")[1].body).toEqual({ provider: "Brave Search (Free)" });
    expect(await within(p).findByText("aktiv", { selector: ".tag" })).toBeInTheDocument();
  });

  it("picks a model for image generation from the catalog", async () => {
    await open();
    const p = await panel("Bilder");
    const select = await within(p).findByLabelText("Modell");
    expect(select).toHaveValue("flux-2-pro");
    expect(within(p).getByRole("option", { name: /FLUX 2 Klein/ })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "flux-2-klein" } });
    fireEvent.click(within(p).getByRole("button", { name: "Modell speichern" }));
    await waitFor(() => expect(writes("/model")).toHaveLength(1));
    expect(writes("/model")[0].body).toEqual({ model: "flux-2-klein" });
  });

  it("offers no model choice where there is no catalog", async () => {
    await open();
    const p = await panel("Web");
    await within(p).findByLabelText("BRAVE_SEARCH_API_KEY");
    expect(within(p).queryByLabelText("Modell")).not.toBeInTheDocument();
  });

  it("asks for a fresh login when the change needs one", async () => {
    await open();
    backend.dash.stepUp = true;
    const p = await panel("Web");
    fireEvent.click(within(p).getByRole("button", { name: "Einschalten" }));
    expect(await within(p).findByRole("alert")).toHaveTextContent("frische Anmeldung");
    expect(within(p).getByRole("button", { name: "Erneut anmelden" })).toBeInTheDocument();
  });

  it("shows the terminal backend but offers no way to change it here", async () => {
    await open();
    const note = await screen.findByText(/Terminal-Backend/);
    expect(note.closest("section")).toHaveTextContent("local");
    expect(note.closest("section")).toHaveTextContent("keine Isolation");
    expect(note.closest("section")).toHaveTextContent("Hermes-Dashboard");
    expect(note.closest("section")!.querySelectorAll("button, select, input")).toHaveLength(0);
  });

  it("closes the panel again", async () => {
    await open();
    await panel("Web");
    fireEvent.click(screen.getByRole("button", { name: "Web einrichten" }));
    expect(screen.queryByRole("region", { name: "Einstellungen für Web" })).not.toBeInTheDocument();
  });
});
