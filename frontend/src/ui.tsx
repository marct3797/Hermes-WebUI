import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";
import type { AgentRef, ShaderConfig, SigilConfig, UiConfig } from "./types";

export const DEFAULT_SHADER: ShaderConfig = { enabled: true, strength: 1.6, speed: 1 };

type UiState = { sigils: Record<string, SigilConfig>; shader: ShaderConfig };

const Ctx = createContext<UiState>({ sigils: {}, shader: DEFAULT_SHADER });

/** Sigils und Shader-Einstellung aus der WebUI-Config. Fehlt sie oder ist sie nicht lesbar, gelten Initialen und Standardwerte. */
export function UiProvider({ children }: { children: ReactNode }) {
  const [cfg, setCfg] = useState<UiConfig>();
  useEffect(() => {
    let stale = false;
    api.ui().then((c) => { if (!stale) setCfg(c); }).catch(() => undefined);
    return () => { stale = true; };
  }, []);
  const value = useMemo(() => ({ sigils: cfg?.sigils ?? {}, shader: cfg?.ui.backgroundShader ?? DEFAULT_SHADER }), [cfg]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useUi = () => useContext(Ctx);

/** Eintrag für genau diesen Agent (`host/runtime/agent`), sonst für den Profilnamen allein. */
export function sigilFor(sigils: Record<string, SigilConfig>, ref: AgentRef): SigilConfig | undefined {
  return sigils[`${ref.host}/${ref.runtime}/${ref.agent}`] ?? sigils[ref.agent];
}
