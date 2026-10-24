import { useState } from "react";
import { ApiError, api } from "../../api";
import type { AgentRef, MsgPlatform, MsgVar } from "../../types";
import { Icon } from "../Icon";
import { StepUpNote, webUrl } from "../providers/StepUpNote";
import { TelegramWizard } from "./TelegramWizard";

type Props = { agent: AgentRef; platform: MsgPlatform; onChanged: () => void };

/**
 * Eine Plattform einrichten. Die Variablen kommen von Hermes. Geheimnisse (Tokens) werden nur geschrieben: das Feld bleibt leer, daneben steht
 * „gesetzt“. Gesendet wird nur, was geändert wurde. Löschen verlangt einen zweiten Klick.
 */
export function PlatformPanel({ agent, platform: p, onChanged }: Props) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [stepUp, setStepUp] = useState(false);
  const [note, setNote] = useState<string>();
  const [confirmClear, setConfirmClear] = useState<string>();
  const [wizard, setWizard] = useState(false);

  const changed = p.env_vars.filter((v) => {
    const e = edits[v.key];
    return e !== undefined && (v.is_password ? e.trim() !== "" : e.trim() !== (v.value ?? ""));
  });
  const switched = enabled !== undefined && enabled !== p.enabled;
  const docs = webUrl(p.docs_url ?? undefined);

  const run = async (action: () => Promise<unknown>, after?: () => void) => {
    setBusy(true); setError(undefined); setStepUp(false); setNote(undefined);
    try { await action(); after?.(); onChanged(); }
    catch (e) { if (e instanceof ApiError && e.code === "step_up_required") setStepUp(true); else setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const save = () => run(
    () => api.saveMessaging(agent, p.id, { ...(switched ? { enabled } : {}), ...(changed.length ? { env: Object.fromEntries(changed.map((v) => [v.key, edits[v.key].trim()])) } : {}) }),
    () => { setEdits({}); setEnabled(undefined); setNote("Gespeichert. Die Änderung gilt ab dem nächsten Start des Gateways."); },
  );
  const clear = (key: string) => run(() => api.saveMessaging(agent, p.id, { clear_env: [key] }), () => { setConfirmClear(undefined); setNote("Gespeichert. Die Änderung gilt ab dem nächsten Start des Gateways."); });
  const check = () => run(async () => { const r = await api.testMessaging(agent, p.id); setNote(r.message); });

  const field = (v: MsgVar) => (
    <div className="pf-fld" key={v.key}>
      <label htmlFor={`msg-${p.id}-${v.key}`}>{v.key}</label>
      <div className="row" style={{ gap: 8 }}>
        <input id={`msg-${p.id}-${v.key}`} aria-label={v.key} className="pf-in mono grow" type={v.is_password ? "password" : "text"} autoComplete="off" spellCheck={false}
          value={edits[v.key] ?? (v.is_password ? "" : v.value ?? "")} placeholder={v.is_password ? (v.is_set ? "Neuen Wert einfügen, um ihn zu ersetzen" : v.prompt ?? "") : v.prompt ?? ""}
          onChange={(e) => setEdits({ ...edits, [v.key]: e.target.value })} />
        {v.required && <span className="tag tag-m">Pflicht</span>}
        {v.is_password && <span className={`tag${v.is_set ? " tag-c" : ""}`}>{v.is_set ? "gesetzt" : "nicht gesetzt"}</span>}
        {v.is_set && (confirmClear === v.key
          ? <button type="button" className="btn btn-s btn-g" disabled={busy} onClick={() => void clear(v.key)}>Wirklich löschen</button>
          : <button type="button" className="btn btn-s btn-g" disabled={busy} aria-label={`${v.key} löschen`} onClick={() => setConfirmClear(v.key)}>Löschen</button>)}
      </div>
      {v.description && v.description !== v.prompt && <span className="hint">{v.description}</span>}
    </div>
  );

  return (
    <section className="card tool-panel" role="region" aria-label={`Einstellungen für ${p.name}`}>
      <div className="row" style={{ gap: 8 }}>
        <b>{p.name}</b>
        {docs && <a className="hint" href={docs} target="_blank" rel="noreferrer noopener">Dokumentation</a>}
      </div>
      {p.description && <p className="muted small" style={{ margin: 0 }}>{p.description}</p>}
      {p.error_message && <p className="banner" role="status"><Icon name="alert" /><span>{p.error_message}</span></p>}
      <label className="row" style={{ gap: 8 }}>
        <input type="checkbox" checked={enabled ?? p.enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Plattform aktiv
      </label>
      {p.env_vars.map(field)}
      {stepUp && <StepUpNote what="Diese Änderung" />}
      {error && <p className="banner" role="alert"><Icon name="alert" /><span>{error}</span></p>}
      {note && <p className="muted small" role="status" style={{ margin: 0 }}>{note}</p>}
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-s btn-p" disabled={busy || (!switched && changed.length === 0)} onClick={() => void save()}><Icon name="check" size={14} />Speichern</button>
        <button type="button" className="btn btn-s btn-g" disabled={busy} onClick={() => void check()}>Verbindung prüfen</button>
        {p.id === "telegram" && !wizard && <button type="button" className="btn btn-s btn-g" onClick={() => setWizard(true)}>Bot mit Assistent einrichten</button>}
      </div>
      {wizard && <TelegramWizard agent={agent} onClose={() => setWizard(false)} onApplied={onChanged} />}
    </section>
  );
}
