import { useState } from "react";
import { ApiError } from "../api";
import { StepUpNote } from "./providers/StepUpNote";
import { t } from "../i18n";

/** Aufruf mit Zustand: Fehlertext, Hinweis auf frische Anmeldung (401 step_up_required) oder fehlendes Dashboard (501/503). */
export function useAction() {
  const [error, setError] = useState<string>();
  const [stepUp, setStepUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true); setError(undefined); setStepUp(false);
    try { await fn(); return true; }
    catch (e) {
      if (e instanceof ApiError && e.code === "step_up_required") setStepUp(true);
      else setError((e as Error).message);
      return false;
    }
    finally { setBusy(false); }
  };
  const notes = <>{stepUp && <StepUpNote what={t("Diese Änderung")} />}{error && <p className="banner" role="alert">{error}</p>}</>;
  return { run, notes, busy };
}
