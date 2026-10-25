import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { GUIDE } from "../guide";
import { installBackend } from "../test-backend";

let calls: ReturnType<typeof installBackend>["calls"];

async function open(agents = ["gamma"]) {
  ({ calls } = installBackend(agents));
  history.pushState(null, "", "/guide");
  render(<App />);
  await screen.findByRole("heading", { name: "Anleitungen", level: 1 });
}
const card = (id: string) => within(screen.getByRole("region", { name: GUIDE.find((e) => e.id === id)!.title }));

beforeEach(() => resetRedirect());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("GuidePage", () => {
  it("renders every entry with title, command and warning", async () => {
    await open();
    expect(GUIDE.length).toBeGreaterThanOrEqual(8);
    for (const e of GUIDE) {
      const c = card(e.id);
      expect(c.getByRole("heading", { name: e.title })).toBeInTheDocument();
      expect(c.getByText(e.noExecute!.command)).toBeInTheDocument();
      expect(c.getByText(e.noExecute!.caution)).toBeInTheDocument();
    }
  });

  it("copies the command of the chosen entry to the clipboard", async () => {
    await open();
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: write } });
    fireEvent.click(card("gateway").getByRole("button", { name: "Befehl kopieren" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith("hermes gateway migrate --dry-run"));
    expect(await card("gateway").findByRole("button", { name: "Kopiert" })).toBeInTheDocument();
  });

  it("links entries without execution to the configuring agent page", async () => {
    await open();
    // mcp hat keine BFF-Schreib-Route und verweist daher auf Erweiterungen
    const mcp = GUIDE.find((e) => e.id === "mcp")!;
    expect(mcp.execute).toBeNull();
    expect(mcp.configurePath).toBe("extensions");
    expect(card("mcp").getByRole("link", { name: mcp.configureLabel! }).getAttribute("href")).toMatch(
      /\/h\/[^/]+\/hermes\/gamma\/extensions/,
    );
    // computeruse ebenfalls: kein Shell-Befehl aus dem Browser
    const cu = GUIDE.find((e) => e.id === "computeruse")!;
    expect(cu.execute).toBeNull();
    expect(card("computeruse").getByRole("link", { name: cu.configureLabel! })).toBeInTheDocument();
  });

  it("executes whatsapp test through the BFF and checks the after state", async () => {
    await open();
    const entry = GUIDE.find((e) => e.id === "whatsapp")!;
    expect(entry.execute).not.toBeNull();
    fireEvent.click(card("whatsapp").getByRole("button", { name: entry.execute!.label }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/messaging/whatsapp/test"))).toBe(true),
    );
    expect((await card("whatsapp").findAllByRole("status")).length).toBeGreaterThan(0);
  });

  it("executes gateway start through the BFF after confirmation", async () => {
    await open();
    const entry = GUIDE.find((e) => e.id === "gateway")!;
    expect(entry.execute).not.toBeNull();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(card("gateway").getByRole("button", { name: entry.execute!.label }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/gateway/start"))).toBe(true),
    );
    expect((await card("gateway").findAllByRole("status")).length).toBeGreaterThan(0);
  });
});
