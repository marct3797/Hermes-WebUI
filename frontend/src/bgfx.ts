import { t as tr } from "./i18n";
/**
 * Hintergrund-Shader: ein Vollflächen-Fragment-Shader (WebGL 1, ohne Bibliothek) mit langsam fließendem, verwirbeltem Rauschen
 * in Zinc und einem Hauch Crimson. Er liegt hinter allen Kacheln und reagiert nicht auf die Maus.
 * Dezent, weil: höchstens etwa 10 % Deckkraft, halbe Auflösung, 30 fps, Pause im Hintergrund-Tab, Stillstand bei
 * „Bewegung reduzieren“, und ohne WebGL fällt er einfach weg (der CSS-Verlauf bleibt).
 * Quelle: Design-Entwurf v2 (shader.js), als Modul gebündelt: kein Inline-Skript, kein eval, keine Fremdquelle.
 */

export type ShaderSettings = { enabled: boolean; strength: number; speed: number };
export type BgFx = { update: (s: ShaderSettings) => void; dispose: () => void };

const VS = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
const FS = [
  "precision mediump float;uniform vec2 r;uniform float t;uniform float k;",
  "float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}",
  "float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);",
  " return mix(mix(h(i),h(i+vec2(1.,0.)),f.x),mix(h(i+vec2(0.,1.)),h(i+vec2(1.,1.)),f.x),f.y);}",
  "float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<4;i++){v+=a*n(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return v;}",
  "void main(){",
  " vec2 uv=gl_FragCoord.xy/r.y;float s=t*.03;",
  " vec2 q=vec2(fbm(uv*1.3+vec2(0.,s)),fbm(uv*1.3+vec2(5.2,1.3)-vec2(s,0.)));",
  " float f=fbm(uv*1.5+2.1*q+vec2(s*.5,0.));",
  " float ridge=smoothstep(.52,.86,f)*smoothstep(.1,.7,q.x);",
  " float haze=pow(f,3.)*.5;",
  " vec3 col=mix(vec3(.60,.60,.68),vec3(.88,.11,.28),smoothstep(.35,.85,q.y));",
  " float a=(.17*ridge+.09*haze)*k;",
  " gl_FragColor=vec4(col*a,a);",
  "}",
].join("\n");

const FRAME_MS = 33; // etwa 30 fps
const START_T = 40; // der Verlauf beginnt nicht bei Null, dort ist das Muster noch glatt

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error(tr("Shader nicht anlegbar"));
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? tr("Shader nicht übersetzbar"));
  return sh;
}

/**
 * Startet den Shader auf diesem Canvas. Gibt `null` zurück, wenn der Browser kein WebGL anbietet.
 * Die Größe folgt dem Elternelement (halbe Auflösung); `reduceMotion` zeichnet einmal und steht dann still.
 */
export function mountBgFx(canvas: HTMLCanvasElement, initial: ShaderSettings, reduceMotion: boolean): BgFx | null {
  let gl: WebGLRenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
  } catch { /* kein WebGL */ }
  if (!gl) return null;

  let uniforms: { r: WebGLUniformLocation | null; t: WebGLUniformLocation | null; k: WebGLUniformLocation | null };
  try {
    const prog = gl.createProgram();
    if (!prog) return null;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    // Ein Dreieck, das den ganzen Bildschirm überdeckt.
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    uniforms = { r: gl.getUniformLocation(prog, "r"), t: gl.getUniformLocation(prog, "t"), k: gl.getUniformLocation(prog, "k") };
  } catch { return null; }

  const ctx = gl;
  let s = { ...initial };
  let t = START_T;
  let last = 0;
  let raf = 0;
  let disposed = false;

  const fit = () => {
    const host = canvas.parentElement;
    if (!host) return;
    const w = Math.max(2, Math.round(host.clientWidth / 2));
    const h = Math.max(2, Math.round(host.clientHeight / 2));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; ctx.viewport(0, 0, w, h); }
  };

  const draw = () => {
    ctx.clearColor(0, 0, 0, 0);
    ctx.clear(ctx.COLOR_BUFFER_BIT);
    if (!s.enabled) return;
    ctx.uniform2f(uniforms.r, canvas.width, canvas.height);
    ctx.uniform1f(uniforms.t, t);
    ctx.uniform1f(uniforms.k, s.strength);
    ctx.drawArrays(ctx.TRIANGLES, 0, 3);
  };

  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    if (document.hidden || now - last < FRAME_MS) return;
    t += Math.min(100, now - last) / 1000 * s.speed;
    last = now;
    draw();
  };
  const run = () => { if (!raf && !disposed && !reduceMotion && s.enabled && s.speed > 0) raf = requestAnimationFrame(loop); };
  const halt = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };

  const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => { fit(); draw(); });
  if (canvas.parentElement) resize?.observe(canvas.parentElement);
  fit();
  draw();
  run();

  return {
    update(next) {
      s = { ...next };
      halt();
      draw();
      run();
    },
    dispose() {
      disposed = true;
      halt();
      resize?.disconnect();
      // Den Kontext freigeben, wenn die Seite wechselt. Bleibt das Canvas stehen (Strict Mode), braucht es ihn gleich wieder.
      if (!canvas.isConnected) ctx.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
