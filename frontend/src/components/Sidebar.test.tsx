import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { installBackend } from "../test-backend";

beforeEach(() => { resetRedirect(); installBackend(["gamma", "eta"]); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Sidebar", () => {
  it("lists the areas of the chosen Hermes agent as plain links, so none hides in an icon row", async () => {
    history.pushState(null, "", "/h/server/hermes/gamma/providers");
    render(<App />);
    const areas = await screen.findByRole("group", { name: "Bereiche von gamma" });
    const link = (name: string) => within(areas).getByRole("link", { name });
    expect(link("SOUL & Profil")).toHaveAttribute("href", "/h/server/hermes/gamma/soul");
    expect(link("Keys & Nutzung")).toHaveAttribute("href", "/h/server/hermes/gamma/providers");
    expect(link("Keys & Nutzung")).toHaveAttribute("aria-current", "page");
    expect(link("Skills")).toHaveAttribute("href", "/h/server/hermes/gamma/skills");
    expect(link("Werkzeuge")).toHaveAttribute("href", "/h/server/hermes/gamma/tools");
    expect(screen.queryByRole("group", { name: "Bereiche von eta" })).not.toBeInTheDocument();
  });

  it("shows which build is running, so a deploy can be checked at a glance", async () => {
    history.pushState(null, "", "/");
    render(<App />);
    expect(await screen.findByText("Stand 3f5c30c")).toBeInTheDocument();
  });
});
