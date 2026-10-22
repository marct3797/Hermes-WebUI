import { useEffect, useRef } from "react";
import { mountBgFx, type BgFx as Instance } from "../bgfx";
import { useMedia } from "../useMedia";
import { useUi } from "../ui";

/** Auf schmalen Schirmen steht der Shader still und ist ganz aus (Akku). */
const NARROW = "(max-width: 800px)";
const REDUCE = "(prefers-reduced-motion: reduce)";

/** Der Hintergrund-Shader hinter den Kacheln. Gehört als erstes Kind in einen Container mit `isolation:isolate`. */
export function BgFx() {
  const { shader } = useUi();
  const narrow = useMedia(NARROW);
  const reduce = useMedia(REDUCE);
  const canvas = useRef<HTMLCanvasElement>(null);
  const fx = useRef<Instance | null>(null);
  const latest = useRef(shader);
  latest.current = shader;
  const show = shader.enabled && !narrow;

  // Neu aufbauen nur, wenn sich Sichtbarkeit oder Bewegungswunsch ändern; Stärke und Tempo laufen über `update`.
  useEffect(() => {
    if (!show || !canvas.current) return;
    fx.current = mountBgFx(canvas.current, latest.current, reduce);
    return () => { fx.current?.dispose(); fx.current = null; };
  }, [show, reduce]);
  useEffect(() => { fx.current?.update(shader); }, [shader]);

  return show ? <canvas ref={canvas} className="bgfx" aria-hidden /> : null;
}
