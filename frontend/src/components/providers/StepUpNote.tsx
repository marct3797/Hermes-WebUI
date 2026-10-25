import { toLogin } from "../../api";
import { Icon } from "../Icon";
import { t } from "../../i18n";

/** Hinweis, wenn das BFF für eine Änderung eine frische Anmeldung verlangt (Schlüssel, Anmeldung bei Anbietern, Modelle). */
export function StepUpNote({ what }: { what: string }) {
  return (
    <p className="banner" role="alert"><Icon name="lock" /><span>{what} {t("verlangt eine frische Anmeldung.")}{" "}
      <button type="button" className="linkish" onClick={() => toLogin(true)}>{t("Erneut anmelden")}</button></span></p>
  );
}

/** Nur Web-Adressen werden zu Links: der Wert kommt von einem Dashboard auf einem anderen Rechner. */
export function webUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}
