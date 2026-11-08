import { useState } from "react";
import { ApiError } from "./api";
import { Icon } from "./components/Icon";
import { StepUpNote } from "./components/providers/StepUpNote";
import { t } from "./i18n";

/** Fehler eines Aufrufs als Text oder Hinweis auf frische Anmeldung / fehlendes Dashboard. */
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
      else if (e instanceof ApiError && e.status === 501) { setMissing(true); setError(e.message); } // die Meldung des BFF unterscheidet „kein Dashboard“ von „Hermes zu alt“
      else setError((e as Error).message);
      return false;
    }
    finally { setBusy(false); }
  };
  const notes = <>{stepUp && <StepUpNote what={t("Diese Änderung")} />}{error && <p className="banner" role="alert"><Icon name="alert" />{error}</p>}</>;
  return { run, busy, notes, setError, missing };
}

