import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { installBackend } from "../test-backend";

let backend: ReturnType<typeof installBackend>;
async function open() {
  backend = installBackend(["gamma"]);
  history.pushState(null, "", "/h/server/hermes/gamma/zugang");
  render(<App />);
  await screen.findByRole("heading", { name: "Zugang und Webhooks", level: 1 });
}
const sent = (method: string, part: string) => backend.calls.filter((c) => c.method === method && c.url.includes(part));
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => { resetRedirect(); sessionStorage.clear(); vi.spyOn(window, "confirm").mockReturnValue(true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Zugang und Webhooks", () => {
  it("approves a pending request by id and lists the user as approved", async () => {
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Freigeben 42" }));
    await screen.findByText(/Anna \(telegram, ID 42\)/);
    expect(sent("POST", "/hermes-pairing/approve")).toHaveLength(1);
  });

  it("revokes only after typing the user id", async () => {
    await open();
    const btn = await screen.findByRole("button", { name: "Sperren 7" });
    expect(btn).toBeDisabled();
    type("ID zum Sperren 7", "7");
    fireEvent.click(screen.getByRole("button", { name: "Sperren 7" }));
    await waitFor(() => expect(screen.queryByText(/Bob/)).toBeNull());
  });

  it("asks before switching webhooks on, then creates one and shows the secret once", async () => {
    await open();
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(await screen.findByRole("button", { name: "Webhooks einschalten" }));
    expect(sent("POST", "/hermes-webhooks/enable")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Webhooks einschalten" }));
    await screen.findByLabelText("Webhook-Name");
    type("Webhook-Name", "Bad Name!");
    expect(screen.getByRole("button", { name: "Webhook anlegen" })).toBeDisabled();
    type("Webhook-Name", "github-push"); type("Ereignisse", "push, issues");
    fireEvent.click(screen.getByRole("button", { name: "Webhook anlegen" }));
    await screen.findByText(/whsec-EINMALIG-123/);
    expect(JSON.stringify(sent("POST", "/hermes-webhooks")[0])).not.toMatch(/script|"secret"/);
    fireEvent.click(screen.getByRole("button", { name: "Secret ausblenden" }));
    expect(document.body.textContent).not.toContain("whsec-EINMALIG-123");
  });

  it("deletes a webhook only after typing its name", async () => {
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Webhooks einschalten" }));
    await screen.findByLabelText("Webhook-Name");
    type("Webhook-Name", "github-push");
    fireEvent.click(screen.getByRole("button", { name: "Webhook anlegen" }));
    await screen.findByText(/whsec-EINMALIG-123/);
    expect(screen.getByRole("button", { name: "Löschen github-push" })).toBeDisabled();
    type("Name zum Löschen github-push", "github-push");
    fireEvent.click(screen.getByRole("button", { name: "Löschen github-push" }));
    await waitFor(() => expect(sent("DELETE", "confirm=github-push")).toHaveLength(1));
  });
});
