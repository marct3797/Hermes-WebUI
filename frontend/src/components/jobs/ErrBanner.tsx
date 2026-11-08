import { ApiError, toLogin } from "../../api";
import { Icon } from "../Icon";
import { t } from "../../i18n";

/** Fehler einer schreibenden Aktion: bei fehlender frischer Anmeldung mit Weg zur Anmeldung, sonst mit dem Grund. */
export function ErrBanner({ err }: { err: unknown }) {
  if (!err) return null;
  if (err instanceof ApiError && err.code === "step_up_required")
    return <p className="banner" role="alert"><Icon name="lock" /><span>{t("Diese Aktion verlangt eine frische Anmeldung.")} <button type="button" className="linkish" onClick={() => toLogin(true)}>{t("Erneut anmelden")}</button></span></p>;
  return <p className="banner" role="alert"><Icon name="alert" /><span>{err instanceof Error ? err.message : String(err)}</span></p>;
}
