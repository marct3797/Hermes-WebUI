import { vi } from "vitest";

/** Eine WebGL-Attrappe, die mitschreibt, was gezeichnet wurde. */
export function fakeGl(compileOk = true) {
  const uniforms: Record<string, number> = {};
  const lose = vi.fn();
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, ARRAY_BUFFER: 4, STATIC_DRAW: 5, FLOAT: 6, TRIANGLES: 7, COLOR_BUFFER_BIT: 8,
    createShader: () => ({}), shaderSource: vi.fn(), compileShader: vi.fn(), getShaderParameter: () => compileOk, getShaderInfoLog: () => "boom",
    createProgram: () => ({}), attachShader: vi.fn(), linkProgram: vi.fn(), useProgram: vi.fn(), createBuffer: () => ({}),
    bindBuffer: vi.fn(), bufferData: vi.fn(), getAttribLocation: () => 0, enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(),
    getUniformLocation: (_p: unknown, name: string) => name, viewport: vi.fn(), clearColor: vi.fn(), clear: vi.fn(),
    uniform2f: vi.fn(), uniform1f: (loc: string, v: number) => { uniforms[loc] = v; }, drawArrays: vi.fn(),
    getExtension: () => ({ loseContext: lose }),
  };
  return { gl, uniforms, lose };
}
