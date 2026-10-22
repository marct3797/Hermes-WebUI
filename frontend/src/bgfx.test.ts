import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountBgFx } from "./bgfx";
import { fakeGl } from "./test-gl";

let queue: Array<FrameRequestCallback | undefined> = [];
const pending = () => queue.filter(Boolean).length;
/** Einen Frame ausführen, als wäre `now` Millisekunden vergangen. */
function frame(now: number) {
  const cbs = queue.filter(Boolean) as FrameRequestCallback[];
  queue = [];
  cbs.forEach((cb) => cb(now));
}

let host: HTMLDivElement;
let canvas: HTMLCanvasElement;

function setup(gl: unknown) {
  canvas.getContext = (() => gl) as never;
}

beforeEach(() => {
  queue = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { queue.push(cb); return queue.length; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { queue[id - 1] = undefined; });
  host = document.createElement("div");
  canvas = document.createElement("canvas");
  host.append(canvas);
  document.body.append(host);
});
afterEach(() => { host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const on = { enabled: true, strength: 1.6, speed: 1 };

describe("Hintergrund-Shader", () => {
  it("falls away quietly without WebGL or when the shader does not compile", () => {
    setup(null);
    expect(mountBgFx(canvas, on, false)).toBeNull();
    setup(fakeGl(false).gl);
    expect(mountBgFx(canvas, on, false)).toBeNull();
    expect(pending()).toBe(0);
  });

  it("draws at once with the chosen strength and keeps going at about 30 fps", () => {
    const { gl, uniforms } = fakeGl();
    setup(gl);
    const fx = mountBgFx(canvas, on, false);
    expect(fx).not.toBeNull();
    expect(gl.drawArrays).toHaveBeenCalledTimes(1);
    expect(uniforms.k).toBe(1.6);
    expect(uniforms.t).toBe(40);
    expect(pending()).toBe(1);
    frame(10); // zu früh: kein neuer Frame
    expect(gl.drawArrays).toHaveBeenCalledTimes(1);
    frame(40);
    expect(gl.drawArrays).toHaveBeenCalledTimes(2);
    expect(uniforms.t).toBeCloseTo(40.04, 3); // 40 ms bei Tempo 1
    fx!.dispose();
  });

  it("is a still image when the system asks for less motion, and still follows strength changes", () => {
    const { gl, uniforms } = fakeGl();
    setup(gl);
    const fx = mountBgFx(canvas, on, true)!;
    expect(gl.drawArrays).toHaveBeenCalledTimes(1);
    expect(pending()).toBe(0);
    fx.update({ ...on, strength: 3 });
    expect(uniforms.k).toBe(3);
    expect(gl.drawArrays).toHaveBeenCalledTimes(2);
    expect(pending()).toBe(0);
  });

  it("pauses while the tab is hidden", () => {
    const { gl } = fakeGl();
    setup(gl);
    mountBgFx(canvas, on, false);
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    frame(100);
    frame(200);
    expect(gl.drawArrays).toHaveBeenCalledTimes(1);
    hidden.mockReturnValue(false);
    frame(300);
    expect(gl.drawArrays).toHaveBeenCalledTimes(2);
  });

  it("stops the loop when switched off and restarts it when switched on again", () => {
    const { gl } = fakeGl();
    setup(gl);
    const fx = mountBgFx(canvas, on, false)!;
    fx.update({ ...on, enabled: false });
    expect(pending()).toBe(0);
    expect(gl.clear).toHaveBeenCalled();
    expect(gl.drawArrays).toHaveBeenCalledTimes(1); // beim Ausschalten nur leeren
    fx.update({ ...on, speed: 2 });
    expect(pending()).toBe(1);
    expect(gl.drawArrays).toHaveBeenCalledTimes(2);
  });

  it("stops moving at tempo 0 and releases the context only when its canvas has left the page", () => {
    const { gl, lose } = fakeGl();
    setup(gl);
    const fx = mountBgFx(canvas, { ...on, speed: 0 }, false)!;
    expect(pending()).toBe(0);
    fx.update(on);
    expect(pending()).toBe(1);
    fx.dispose();
    expect(pending()).toBe(0);
    expect(lose).not.toHaveBeenCalled(); // Canvas steht noch (Strict Mode baut gleich wieder auf)
    const again = mountBgFx(canvas, on, false)!;
    canvas.remove();
    again.dispose();
    expect(lose).toHaveBeenCalledTimes(1);
  });
});
