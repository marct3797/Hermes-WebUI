import { useState } from "react";
import { ApiError } from "../api";
import { StepUpNote } from "./providers/StepUpNote";

/** Aufruf mit Zustand: Fehlertext, Hinweis auf frische Anmeldung (401 step_up_required) oder fehlendes Dashboard (501/503). */
export function useAction() {
  const [error, setError] = useState<string>();
  const [stepUp, setStepUp] = useState(false);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true); setError(undefined); setStepUp(false); setMissing(false);
    try { await fn(); return true; }
    catch (e) {
      if (e instanceof ApiError && e.code === "step_up_required") setStepUp(true);
      else if (e instanceof ApiError && e.status === 501) setMissing(true);
      else setError((e as Error).message);
      return false;
    }
    finally { setBusy(false); }
  };
  const notes = <>{stepUp && <StepUpNote what="Diese Änderung" />}{missing && <p className="banner">Für diese Runtime ist kein Dashboard eingerichtet.</p>}{error && <p className="banner" role="alert">{error}</p>}</>;
  return { run, notes, busy };
}
