import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import { resetRedirect } from "../../api";
import { installBackend } from "../../test-backend";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); resetRedirect(); });

async function open() {
  const backend = installBackend(["gamma", "eta"]);
  history.pushState(null, "", "/providers");
  render(<App />);
  const group = await screen.findByRole("group", { name: "Coding-CLIs auf Server" });
  await within(group).findByText(/ANGEMELDET · ChatGPT/);
  return { backend, group };
}

describe("CliPanel", () => {
  it("zeigt Zustand je CLI als Badge, ehrlich auch bei unbekannt und ohne Host-Dienst", async () => {
    const { group } = await open();
    expect(within(group).getByText("ABGEMELDET")).toBeInTheDocument();
    expect(within(group).getByText(/UNBEKANNT · Zeitueberschreitung/)).toBeInTheDocument();
    expect(within(group).getByText(/Das Abo gilt nur in der echten CLI/)).toBeInTheDocument();
    const laptop = await screen.findByRole("group", { name: "Coding-CLIs auf Laptop" });
    expect(await within(laptop).findByText("Host-Dienst nicht eingerichtet")).toBeInTheDocument();
    expect(within(laptop).getByRole("button", { name: /Prüfen/ })).toBeDisabled();
  });

  it("Prüfen ruft refresh per POST und zeigt das neue Ergebnis", async () => {
    const { backend, group } = await open();
    fireEvent.click(within(group).getByRole("button", { name: /Prüfen/ }));
    await waitFor(() => expect(within(group).queryByText("ABGEMELDET")).toBeNull());
    expect(within(group).getByText(/ANGEMELDET · claude\.ai/)).toBeInTheDocument();
    expect(backend.calls.some((c) => c.method === "POST" && c.url === "/bff/h/server/_cli-auth/refresh")).toBe(true);
  });

  it("Terminal öffnen verlinkt mit vorgewählter CLI; die Anbieter-Tabelle zeigt den Punkt nur lesend", async () => {
    const { group } = await open();
    expect(within(group).getByRole("link", { name: /Claude Code auf Server/ })).toHaveAttribute("href", "/hosts/server/terminal?cli=claude");
    const region = await screen.findByRole("region", { name: "Anbieter auf Server" });
    await within(region).findByRole("table");
    expect((await within(region).findAllByRole("img", { name: /CLI OpenCode: unbekannt/ })).length).toBeGreaterThan(0);
  });

  it("Seitenaufruf liest nur (GET) und löst nie eine Prüfung aus; Nie-Geprüftes steht als solches da", async () => {
    const { backend, group } = await open();
    expect(backend.calls.filter((c) => c.url.includes("_cli-auth")).every((c) => c.method === "GET" && !c.url.endsWith("/refresh"))).toBe(true);
    expect(within(group).getByText("NICHT GEPRÜFT")).toBeInTheDocument();
  });
});
