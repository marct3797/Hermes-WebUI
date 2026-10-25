import { useState } from "react";
import { ApiError, api, toLogin } from "../../api";
import type { AgentRef, ProviderGroup } from "../../types";
import { Icon } from "../Icon";
import { t } from "../../i18n";

type Props = { agent: AgentRef; group: ProviderGroup; onSaved: (message: string) => void; onCancel: () => void };

/**
 * Key eintragen oder ersetzen. Der Wert geht nur an das BFF (nie in die Adresse, nie in den Browser-Speicher), wird beim Anbieter
 * geprüft und dann gespeichert. Danach zeigt die Seite nur noch die geschwärzte Form.
 */
export function KeyForm({ agent, group, onSaved, onCancel }: Props) {
  const vars = group.keys.filter((k) => k.secret);
  const options = vars.filter((k) => !k.advanced).length > 0 ? vars.filter((k) => !k.advanced) : vars;
  const [name, setName] = useState((options.find((k) => k.set) ?? options[0])?.var ?? "");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [stepUp, setStepUp] = useState(false);

  const submit = async () => {
    setBusy(true); setError(undefined); setStepUp(false);
    try {
      const check = await api.validateKey(agent, name, value);
      if (!check.ok && check.reachable) { setError(check.message || t("Der Anbieter hat den Key abgelehnt.")); return; }
      await api.saveKey(agent, name, value);
      setValue("");
      onSaved(check.reachable ? t("Key für {label} gespeichert und geprüft.", { label: group.label }) : t("Key für {label} gespeichert. Der Anbieter ließ sich nicht zur Prüfung erreichen.", { label: group.label }));
    } catch (e) {
      if (e instanceof ApiError && e.code === "step_up_required") setStepUp(true);
      else setError((e as Error).message);
    } finally { setBusy(false); }
  };

  const current = vars.find((k) => k.var === name);
  return (
    <form className="prov-form" onSubmit={(e) => { e.preventDefault(); void submit(); }} aria-label={t("Key für {label}", { label: group.label })}>
      {options.length > 1 && (
        <div className="pf-fld">
          <label htmlFor={`kv-${group.id}`}>{t("Variable")}</label>
          <select id={`kv-${group.id}`} className="pf-in" value={name} onChange={(e) => setName(e.target.value)}>
            {options.map((k) => <option key={k.var} value={k.var}>{k.var}{k.set ? " (gesetzt)" : ""}</option>)}
          </select>
        </div>
      )}
      <div className="pf-fld">
        <label htmlFor={`kk-${group.id}`}>{options.length > 1 ? t("Neuer Wert") : name}</label>
        <input id={`kk-${group.id}`} className="pf-in mono" type="password" autoComplete="off" spellCheck={false} value={value} placeholder={current?.set ? t("Neuen Key einfügen, um ihn zu ersetzen") : t("Key einfügen")}
          onChange={(e) => setValue(e.target.value.trim())} />
        {current?.url && <a className="hint" href={current.url} target="_blank" rel="noreferrer noopener">{t("Key beim Anbieter anlegen")}</a>}
      </div>
      {stepUp && (
        <p className="banner" role="alert"><Icon name="lock" /><span>{t("Das Speichern eines Keys verlangt eine frische Anmeldung. Nach der Anmeldung den Key erneut einfügen.")}{" "}
          <button type="button" className="linkish" onClick={() => toLogin(true)}>{t("Erneut anmelden")}</button></span></p>
      )}
      {error && <p className="banner" role="alert"><Icon name="alert" /><span>{error}</span></p>}
      <div className="row" style={{ gap: 8 }}>
        <button type="submit" className="btn btn-p btn-s" disabled={busy || !value || !name}><Icon name="check" size={14} />{t("Prüfen und speichern")}</button>
        <button type="button" className="btn btn-s btn-g" onClick={onCancel}>{t("Abbrechen")}</button>
      </div>
    </form>
  );
}
