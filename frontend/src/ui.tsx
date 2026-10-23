import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";
import type { AgentRef, ShaderConfig, SigilConfig, UiConfig } from "./types";

export const DEFAULT_SHADER: ShaderConfig = { enabled: true, strength: 1.6, speed: 1 };

/** Einstellung nur für dieses Gerät (Akku, Geschmack). Sie geht der Vorgabe aus der ui.json vor. */
const LOCAL_KEY = "hermes.shader";
type LocalShader = Partial<ShaderConfig>;

const inRange = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 3;

function readLocal(): LocalShader {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "{}") as Record<string, unknown>;
    const out: LocalShader = {};
    if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
    if (inRange(raw.strength)) out.strength = raw.strength;
    if (inRange(raw.speed)) out.speed = raw.speed;
    return out;
  } catch { return {}; }
}

function writeLocal(v: LocalShader) {
  try {
    if (Object.keys(v).length) localStorage.setItem(LOCAL_KEY, JSON.stringify(v));
    else localStorage.removeItem(LOCAL_KEY);
  } catch { /* Speicher gesperrt: die Einstellung gilt dann nur bis zum Neuladen */ }
}

type UiState = {
  sigils: Record<string, SigilConfig>;
  labels: Record<string, string>;
  packs: Record<string, string[]>;
  writable: boolean;
  writeError: string | null;
  /** Wirksam: Einstellung dieses Geräts, sonst die Vorgabe aus der ui.json. */
  shader: ShaderConfig;
  serverShader: ShaderConfig;
  localShader: LocalShader;
  setLocalShader: (patch: LocalShader) => void;
  resetLocalShader: () => void;
  /** Antwort des BFF nach dem Speichern übernehmen. */
  apply: (cfg: UiConfig) => void;
};

const NONE = () => undefined;
const Ctx = createContext<UiState>({
  sigils: {}, labels: {}, packs: {}, writable: false, writeError: null,
  shader: DEFAULT_SHADER, serverShader: DEFAULT_SHADER, localShader: {}, setLocalShader: NONE, resetLocalShader: NONE, apply: NONE,
});

/** Sigils, Namen, Packs und Shader-Einstellung aus der WebUI-Config. Fehlt sie oder ist sie nicht lesbar, gelten Initialen und Standardwerte. */
export function UiProvider({ children }: { children: ReactNode }) {
  const [cfg, setCfg] = useState<UiConfig>();
  const [local, setLocal] = useState<LocalShader>(readLocal);
  useEffect(() => {
    let stale = false;
    api.ui().then((c) => { if (!stale) setCfg(c); }).catch(() => undefined);
    return () => { stale = true; };
  }, []);

  const setLocalShader = useCallback((patch: LocalShader) => setLocal((cur) => { const next = { ...cur, ...patch }; writeLocal(next); return next; }), []);
  const resetLocalShader = useCallback(() => { writeLocal({}); setLocal({}); }, []);

  const value = useMemo<UiState>(() => {
    const serverShader = cfg?.ui.backgroundShader ?? DEFAULT_SHADER;
    return {
      sigils: cfg?.sigils ?? {}, labels: cfg?.labels ?? {}, packs: cfg?.packs ?? {},
      writable: cfg?.writable ?? false, writeError: cfg ? cfg.write_error : null,
      shader: { ...serverShader, ...local }, serverShader, localShader: local, setLocalShader, resetLocalShader, apply: setCfg,
    };
  }, [cfg, local, setLocalShader, resetLocalShader]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useUi = () => useContext(Ctx);

/** Schlüssel der Config: genau dieser Agent (`host/runtime/agent`), allgemeiner nur der Profilname. */
export const profileKey = (ref: AgentRef) => `${ref.host}/${ref.runtime}/${ref.agent}`;

/** Eintrag für genau diesen Agent (`host/runtime/agent`), sonst für den Profilnamen allein. */
export function sigilFor(sigils: Record<string, SigilConfig>, ref: AgentRef): SigilConfig | undefined {
  return sigils[profileKey(ref)] ?? sigils[ref.agent];
}

/** Anzeigename aus der Config, sonst `undefined` (dann gilt der Name aus der Registry). */
export function labelFor(labels: Record<string, string>, ref: AgentRef): string | undefined {
  return labels[profileKey(ref)] ?? labels[ref.agent];
}
