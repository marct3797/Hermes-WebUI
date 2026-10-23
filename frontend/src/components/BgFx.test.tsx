import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { baseUi } from "../test-backend";
import { fakeGl } from "../test-gl";
import type { UiConfig } from "../types";
import { UiProvider } from "../ui";
import { BgFx } from "./BgFx";

const cfg = (strength = 1.6, enabled = true): UiConfig => ({ ...baseUi(), ui: { backgroundShader: { enabled, strength, speed: 1 } } });

let gl: ReturnType<typeof fakeGl>;
function media(matching: string[]) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: matching.includes(q), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
}
const mount = () => render(<UiProvider><div className="main"><BgFx /></div></UiProvider>);

beforeEach(() => {
  localStorage.clear();
  gl = fakeGl();
  HTMLCanvasElement.prototype.getContext = (() => gl.gl) as never;
  media([]);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});

describe("BgFx", () => {
  it("draws the shader behind the page with the strength from the config", async () => {
    vi.spyOn(api, "ui").mockResolvedValue(cfg(2.2));
    const { container } = mount();
    expect(container.querySelector(".main > canvas.bgfx")).toHaveAttribute("aria-hidden", "true");
    await waitFor(() => expect(gl.uniforms.k).toBe(2.2));
  });

  it("is not there when the config switches it off", async () => {
    vi.spyOn(api, "ui").mockResolvedValue(cfg(1.6, false));
    const { container } = mount();
    await waitFor(() => expect(container.querySelector("canvas")).toBeNull());
  });

  it("prefers the setting of this device over the config", async () => {
    localStorage.setItem("hermes.shader", JSON.stringify({ enabled: false }));
    vi.spyOn(api, "ui").mockResolvedValue(cfg());
    const { container } = mount();
    await waitFor(() => expect(api.ui).toHaveBeenCalled());
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("stays off on narrow screens to save battery", async () => {
    media(["(max-width: 800px)"]);
    vi.spyOn(api, "ui").mockResolvedValue(cfg());
    const { container } = mount();
    await waitFor(() => expect(api.ui).toHaveBeenCalled());
    expect(container.querySelector("canvas")).toBeNull();
    expect(gl.gl.drawArrays).not.toHaveBeenCalled();
  });

  it("still renders the canvas without WebGL and draws nothing", async () => {
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    vi.spyOn(api, "ui").mockResolvedValue(cfg());
    const { container } = mount();
    await waitFor(() => expect(api.ui).toHaveBeenCalled());
    expect(container.querySelector("canvas.bgfx")).not.toBeNull();
  });
});
