import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { Icon } from "../components/Icon";
import { PageHead } from "../components/PageHead";
import { StepUpNote, webUrl } from "../components/providers/StepUpNote";
import type { AgentRef, HmField, HmOverview, HmProvider } from "../types";

const STATUS: Record<string, string> = { ready: "bereit", needs_config: "Key fehlt", unavailable: "Programm fehlt", missing: "nicht gefunden" };
const FILES = [["memory", "MEMORY.md"], ["user", "USER.md"]] as const;

/** Faehigkeit des Hostes: Fehler eines Aufrufs als Text oder als Hinweis auf die frische Anmeldung. */
function useAction() {
  const [error, setError] = useState<string>();
  const [stepUp, setStepUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true); setError(undefined); setStepUp(false);
    try { await fn(); return true; }
    catch (e) { if (e instanceof ApiError && e.code === "step_up_required") setStepUp(true); else setError((e as Error).message); return false; }
    finally { setBusy(false); }
  };
  const notes = <>{stepUp && <StepUpNote what="Diese Änderung" />}{error && <p className="banner" role="alert"><Icon name="alert" /><span>{error}</span></p>}</>;
  return { run, busy, notes };
}

/**
 * Eingebautes Gedaechtnis (MEMORY.md, USER.md) und externe Anbieter. Das Dashboard nennt vom eingebauten Gedaechtnis nur die Groesse. Der
 * Installationsschritt von Hermes (curl | sh) wird bewusst nicht angeboten: fehlende Programme werden nur genannt.
 */
export function HermesMemoryPage({ agent, label }: { agent: AgentRef; label: string }) {
  const [data, setData] = useState<HmOverview>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => api.hmOverview(agent).then((r) => { setData(r); setError(undefined); }, (e: Error) => setError(e.message)), [agent.host, agent.runtime, agent.agent]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  return (
    <main className="page">
      <PageHead title="Hermes-Gedächtnis" sub={data ? `${label} · ${data.active ? `Anbieter ${data.active}` : "eingebaut"}` : label} />
      {error && <p className="banner" role="alert"><Icon name="alert" />{error}</p>}
      {!data && !error && <p className="muted">Lade…</p>}
      {data && <Builtin agent={agent} files={data.files} onChanged={() => void load()} />}
      {data && (
        <section aria-label="Externe Anbieter" className="mem-prov">
          <h2>Externe Anbieter</h2>
          <p className="muted small">Ohne Anbieter nutzt Hermes das eingebaute Gedächtnis. „Speichern“ aktiviert einen Anbieter, sobald er bereit ist.</p>
          {data.providers.map((p) => <Provider key={p.name} agent={agent} p={p} active={data.active === p.name} onChanged={() => void load()} />)}
        </section>
      )}
    </main>
  );
}

function Builtin({ agent, files, onChanged }: { agent: AgentRef; files: HmOverview["files"]; onChanged: () => void }) {
  const [asking, setAsking] = useState<"memory" | "user">();
  const [typed, setTyped] = useState("");
  const { run, busy, notes } = useAction();
  return (
    <section className="card tool-panel" role="region" aria-label="Eingebautes Gedächtnis">
      <b>Eingebautes Gedächtnis</b>
      <p className="muted small" style={{ margin: 0 }}>Der Inhalt zeigt das Dashboard nicht, nur die Größe. Bearbeiten lässt sich die Datei im Hermes-Profil selbst.</p>
      {FILES.map(([key, name]) => (
        <div key={key} className="row" style={{ gap: 8 }}>
          <span className="grow">{name}: {files[key]} Bytes</span>
          {files[key] > 0 && asking !== key && <button type="button" className="btn btn-s btn-g" onClick={() => { setAsking(key); setTyped(""); }}>{name} zurücksetzen</button>}
        </div>
      ))}
      {asking && (
        <div className="pf-fld">
          <label htmlFor="hm-confirm">Zum Bestätigen „{asking}“ eintippen</label>
          <div className="row" style={{ gap: 8 }}>
            <input id="hm-confirm" className="pf-in mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
            <button type="button" className="btn btn-s btn-p" disabled={busy || typed !== asking} onClick={async () => { if (await run(() => api.hmReset(agent, asking, typed))) { setAsking(undefined); onChanged(); } }}>Endgültig löschen</button>
            <button type="button" className="btn btn-s btn-g" onClick={() => setAsking(undefined)}>Abbrechen</button>
          </div>
          <span className="hint">Das Löschen ist endgültig, es gibt keinen Papierkorb.</span>
        </div>
      )}
      {notes}
    </section>
  );
}

function Provider({ agent, p, active, onChanged }: { agent: AgentRef; p: HmProvider; active: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const { run, busy, notes } = useAction();
  const [note, setNote] = useState<string>();
  return (
    <section className="card tool-panel" role="region" aria-label={`Anbieter ${p.name}`}>
      <div className="row" style={{ gap: 8 }}>
        <b>{p.name}</b>
        <span className="tag">{STATUS[p.status ?? ""] ?? p.status}</span>
        {active && <span className="tag tag-c">aktiv</span>}
        <span className="grow" />
        {active && <button type="button" className="btn btn-s btn-g" disabled={busy} onClick={async () => { if (await run(() => api.hmSetProvider(agent, ""))) onChanged(); }}>Eingebautes Gedächtnis verwenden</button>}
        {p.status === "ready" && !active && <button type="button" className="btn btn-s btn-p" disabled={busy} aria-label={`${p.name} aktivieren`} onClick={async () => { if (await run(() => api.hmSetProvider(agent, p.name))) onChanged(); }}>Aktivieren</button>}
        <button type="button" className="btn btn-s btn-g" aria-expanded={open} aria-label={`${p.name} einrichten`} onClick={() => setOpen(!open)}><Icon name="sliders" size={14} />Einrichten</button>
      </div>
      {p.description && <p className="muted small" style={{ margin: 0 }}>{p.description}</p>}
      {p.missing.length > 0 && (
        <div className="muted small">
          <div>Fehlt: {p.missing.map((m) => m.name).join(", ")}. Zum Installieren auf dem Rechner des Agents ausführen:</div>
          {p.missing.map((m) => <code key={m.name} className="mono">{m.install}</code>)}
        </div>
      )}
      {open && <Fields agent={agent} name={p.name} onSaved={() => { setNote("Gespeichert."); onChanged(); }} />}
      {note && <p className="muted small" role="status" style={{ margin: 0 }}>{note}</p>}
      {notes}
    </section>
  );
}

function Fields({ agent, name, onSaved }: { agent: AgentRef; name: string; onSaved: () => void }) {
  const [fields, setFields] = useState<HmField[]>();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [version, setVersion] = useState(0);
  const { run, busy, notes } = useAction();
  useEffect(() => { void api.hmFields(agent, name).then((r) => setFields(r.fields), () => setFields([])); }, [agent.host, agent.runtime, agent.agent, name, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = (fields ?? []).filter((f) => edits[f.key] !== undefined && (f.kind === "secret" ? edits[f.key].trim() !== "" : edits[f.key] !== (f.value ?? "")));
  if (!fields) return <p className="muted small">Lade…</p>;
  return (
    <form className="prov-form" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.hmSave(agent, name, Object.fromEntries(changed.map((f) => [f.key, f.kind === "secret" ? edits[f.key].trim() : edits[f.key]]))))) { setEdits({}); setVersion((v) => v + 1); onSaved(); } }}>
      {fields.map((f) => {
        const id = `hm-${name}-${f.key}`, link = webUrl(f.url ?? undefined);
        return (
          <div className="pf-fld" key={f.key}>
            <label htmlFor={id}>{f.label ?? f.key}</label>
            <div className="row" style={{ gap: 8 }}>
              {f.kind === "select"
                ? <select id={id} className="pf-in grow" value={edits[f.key] ?? f.value ?? ""} onChange={(e) => setEdits({ ...edits, [f.key]: e.target.value })}>{f.options.map((o) => <option key={o.value} value={o.value}>{o.label ?? o.value}</option>)}</select>
                : <input id={id} className="pf-in mono grow" type={f.kind === "secret" ? "password" : "text"} autoComplete="off" spellCheck={false} value={edits[f.key] ?? (f.kind === "secret" ? "" : f.value ?? "")}
                    placeholder={f.kind === "secret" && f.is_set ? "Neuen Wert einfügen, um ihn zu ersetzen" : f.placeholder ?? ""} onChange={(e) => setEdits({ ...edits, [f.key]: e.target.value })} />}
              {f.kind === "secret" && <span className={`tag${f.is_set ? " tag-c" : ""}`}>{f.is_set ? "gesetzt" : "nicht gesetzt"}</span>}
            </div>
            {f.description && <span className="hint">{f.description}</span>}
            {link && <a className="hint" href={link} target="_blank" rel="noreferrer noopener">Mehr beim Anbieter</a>}
          </div>
        );
      })}
      <div className="row" style={{ gap: 8 }}><button type="submit" className="btn btn-s btn-p" disabled={busy || changed.length === 0}><Icon name="check" size={14} />Speichern</button></div>
      {notes}
    </form>
  );
}
