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

const GO = "/h/server/hermes/gamma/lerngraph";
describe("Lerngraph", () => {
  it("lists nodes with their connections", async () => {
    await open(GO, "Lerngraph");
    await screen.findByText(/2 Knoten, 1 Verbindungen/);
    expect(screen.getByRole("list", { name: "Knoten" }).textContent).toContain("1 Verbindungen");
  });

  it("edits a node and reads the saved text back", async () => {
    await open(GO, "Lerngraph");
    fireEvent.click(await screen.findByRole("button", { name: "skill-a" }));
    const save = await screen.findByRole("button", { name: "Speichern" });
    expect(save).toBeDisabled();
    type("Knoteninhalt", "# Skill A neu");
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(sent("PUT", "/hermes-learning/node")).toHaveLength(1));
    await waitFor(() => expect((screen.getByLabelText("Knoteninhalt") as HTMLTextAreaElement).value).toBe("# Skill A neu"));
  });

  it("deletes a node only after typing its id", async () => {
    await open(GO, "Lerngraph");
    fireEvent.click(await screen.findByRole("button", { name: "mem:1" }));
    await screen.findByLabelText("Knoten-ID zum Löschen");
    expect(screen.getByRole("button", { name: "Knoten löschen" })).toBeDisabled();
    type("Knoten-ID zum Löschen", "mem:1");
    fireEvent.click(screen.getByRole("button", { name: "Knoten löschen" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "mem:1" })).toBeNull());
    expect(sent("DELETE", "/hermes-learning/node")[0].url).toContain("confirm=mem%3A1");
  });
});
