import { useState } from "react";
import { availableLanguages, setLanguage, t, useLanguage, type LanguageId } from "../i18n";

/** Sprachwahl der Oberfläche. Wechselt erst, wenn die Sprachdatei geladen ist; sonst bleibt die bisherige Sprache und der Grund steht daneben. */
export function LanguageSelect() {
  const current = useLanguage();
  const [error, setError] = useState<string>();
  const change = (id: LanguageId) => { setError(undefined); setLanguage(id).catch((e: Error) => setError(t("Die Sprache lässt sich nicht laden: {message}", { message: e.message }))); };
  return (
    <section className="pf-s" aria-label={t("Sprache")}>
      <h2>{t("Sprache")}</h2>
      <label>{t("Sprache der Oberfläche")}
        <select className="field field-line" value={current} onChange={(e) => change(e.target.value as LanguageId)} lang={current}>
          {availableLanguages().map((l) => <option key={l.id} value={l.id} lang={l.id}>{l.endonym}</option>)}
        </select>
      </label>
      <p className="hint">{t("Die Übersetzungen sind maschinell erstellt und nicht von Muttersprachlern geprüft. Korrekturen sind willkommen. Fehlt ein Text in deiner Sprache, erscheint er auf Deutsch.")}</p>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
